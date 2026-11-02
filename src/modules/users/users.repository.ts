import { createRequest, sql, type Queryable } from '../../db/pool';
import type { Role } from '../auth/auth.types';

export interface UserRow {
  UserId: number;
  Name: string;
  Email: string;
  PasswordHash: string;
  Role: Role;
  OfficeId: number;
  ShiftStart: Date;
  IsActive: boolean;
}

const USER_COLUMNS = 'UserId, Name, Email, PasswordHash, Role, OfficeId, ShiftStart, IsActive';

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
