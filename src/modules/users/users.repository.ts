import { createRequest, sql, type Queryable } from '../../db/pool';
import type { Role } from '../auth/auth.types';

export const USER_STATUSES = ['PENDING', 'ACTIVE', 'INACTIVE'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserRow {
  UserId: number;
  Name: string;
  Email: string;
  PasswordHash: string;
  Role: Role;
  OfficeId: number;
  ShiftStart: Date;
  ShiftEnd: Date;
  IsActive: boolean;
  Status: UserStatus;
  CreatedUtc: Date;
}

const USER_COLUMNS =
  'UserId, Name, Email, PasswordHash, Role, OfficeId, ShiftStart, ShiftEnd, IsActive, Status, CreatedUtc';

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const request = await createRequest();
  const result = await request
    .input('email', sql.NVarChar(254), email.toLowerCase())
    .query<UserRow>(`SELECT ${USER_COLUMNS} FROM dbo.Users WHERE Email = @email`);
  return result.recordset[0] ?? null;
}

export async function findUserById(userId: number, db?: Queryable): Promise<UserRow | null> {
  const request = await createRequest(db);
  const result = await request
    .input('userId', sql.Int, userId)
    .query<UserRow>(`SELECT ${USER_COLUMNS} FROM dbo.Users WHERE UserId = @userId`);
  return result.recordset[0] ?? null;
}

export async function updatePasswordHash(
  userId: number,
  passwordHash: string,
  db?: Queryable,
): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('userId', sql.Int, userId)
    .input('hash', sql.NVarChar(100), passwordHash)
    .query('UPDATE dbo.Users SET PasswordHash = @hash, UpdatedUtc = SYSUTCDATETIME() WHERE UserId = @userId');
}

export interface UserListRow {
  UserId: number;
  Name: string;
  Role: Role;
}

export async function listActiveUsers(role?: Role): Promise<UserListRow[]> {
  const request = await createRequest();
  request.input('role', sql.NVarChar(20), role ?? null);
  const result = await request.query<UserListRow>(
    `SELECT UserId, Name, Role FROM dbo.Users
     WHERE IsActive = 1 AND (@role IS NULL OR Role = @role)
     ORDER BY Name`,
  );
  return result.recordset;
}

export async function listActiveUserIds(role?: Role): Promise<number[]> {
  return (await listActiveUsers(role)).map((u) => u.UserId);
}

export interface NewUser {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  officeId: number;
  shiftStart: string;
  shiftEnd: string;
  status: UserStatus;
}

/** Inserts a user and returns its id. Throws a unique violation if the email is taken. */
export async function insertUser(user: NewUser, db?: Queryable): Promise<number> {
  const request = await createRequest(db);
  const result = await request
    .input('name', sql.NVarChar(150), user.name)
    .input('email', sql.NVarChar(254), user.email.toLowerCase())
    .input('hash', sql.NVarChar(100), user.passwordHash)
    .input('role', sql.NVarChar(20), user.role)
    .input('officeId', sql.Int, user.officeId)
    .input('shiftStart', sql.VarChar(5), user.shiftStart)
    .input('shiftEnd', sql.VarChar(5), user.shiftEnd)
    .input('status', sql.NVarChar(20), user.status)
    .query<{ id: number }>(
      `INSERT INTO dbo.Users (Name, Email, PasswordHash, Role, OfficeId, ShiftStart, ShiftEnd, Status, IsActive)
       OUTPUT INSERTED.UserId AS id
       VALUES (@name, @email, @hash, @role, @officeId, CAST(@shiftStart AS TIME(0)),
               CAST(@shiftEnd AS TIME(0)), @status,
               CASE WHEN @status = N'ACTIVE' THEN 1 ELSE 0 END)`,
    );
  return result.recordset[0]!.id;
}

export async function listUsersByStatus(status: UserStatus, role?: Role): Promise<UserRow[]> {
  const request = await createRequest();
  const result = await request
    .input('status', sql.NVarChar(20), status)
    .input('role', sql.NVarChar(20), role ?? null)
    .query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM dbo.Users
       WHERE Status = @status AND (@role IS NULL OR Role = @role)
       ORDER BY Name`,
    );
  return result.recordset;
}

/** Locks the user row for the rest of the transaction. */
export async function findUserForUpdate(userId: number, db: Queryable): Promise<UserRow | null> {
  const request = await createRequest(db);
  const result = await request
    .input('userId', sql.Int, userId)
    .query<UserRow>(`SELECT ${USER_COLUMNS} FROM dbo.Users WITH (UPDLOCK, ROWLOCK) WHERE UserId = @userId`);
  return result.recordset[0] ?? null;
}

export async function setUserStatus(userId: number, status: UserStatus, db?: Queryable): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('userId', sql.Int, userId)
    .input('status', sql.NVarChar(20), status)
    .query(
      `UPDATE dbo.Users
       SET Status = @status, IsActive = CASE WHEN @status = N'ACTIVE' THEN 1 ELSE 0 END,
           UpdatedUtc = SYSUTCDATETIME()
       WHERE UserId = @userId`,
    );
}

export interface UserChanges {
  name?: string;
  role?: Role;
  shiftStart?: string;
  shiftEnd?: string;
}

export async function updateUser(userId: number, changes: UserChanges, db?: Queryable): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('userId', sql.Int, userId)
    .input('name', sql.NVarChar(150), changes.name ?? null)
    .input('role', sql.NVarChar(20), changes.role ?? null)
    .input('shiftStart', sql.VarChar(5), changes.shiftStart ?? null)
    .input('shiftEnd', sql.VarChar(5), changes.shiftEnd ?? null)
    .query(
      `UPDATE dbo.Users
       SET Name = COALESCE(@name, Name),
           Role = COALESCE(@role, Role),
           ShiftStart = COALESCE(CAST(@shiftStart AS TIME(0)), ShiftStart),
           ShiftEnd = COALESCE(CAST(@shiftEnd AS TIME(0)), ShiftEnd),
           UpdatedUtc = SYSUTCDATETIME()
       WHERE UserId = @userId`,
    );
}

/** Hard-deletes a sign-up that was never approved (it owns no attendance, tasks or reports). */
export async function deletePendingUser(userId: number, db?: Queryable): Promise<boolean> {
  const request = await createRequest(db);
  const result = await request.input('userId', sql.Int, userId).query(
    `DELETE FROM dbo.PasswordResets WHERE UserId = @userId;
     DELETE FROM dbo.RefreshTokens WHERE UserId = @userId;
     DELETE FROM dbo.DeviceTokens WHERE UserId = @userId;
     DELETE FROM dbo.Users WHERE UserId = @userId AND Status = N'PENDING';`,
  );
  return result.rowsAffected.at(-1) === 1;
}

/** Cheap per-request check: the current role and whether the account may still be used. */
export async function findAuthState(userId: number): Promise<{ Role: Role; IsActive: boolean } | null> {
  const request = await createRequest();
  const result = await request
    .input('userId', sql.Int, userId)
    .query<{ Role: Role; IsActive: boolean }>('SELECT Role, IsActive FROM dbo.Users WHERE UserId = @userId');
  return result.recordset[0] ?? null;
}
