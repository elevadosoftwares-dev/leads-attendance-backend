import bcrypt from 'bcrypt';
import { createApp } from '../src/app';
import { dateParam, getPool, sql } from '../src/db/pool';
import { signAccessToken } from '../src/modules/auth/token.service';
import type { Role } from '../src/modules/auth/auth.types';
import { combineWorkDateAndTime } from '../src/utils/time';

export const PASSWORD = 'Passw0rd!';
// Low bcrypt cost keeps fixtures fast; verification works the same for any cost.
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

export const OFFICE = { lat: 1.417, lng: 103.868, radius: 150 };

export const app = createApp();

const TABLES = [
  'DailyReports',
  'TaskAttachments',
  'Tasks',
  'Attendance',
  'Leaves',
  'Announcements',
  'DeviceTokens',
  'PasswordResets',
  'RefreshTokens',
  'Users',
  'Offices',
];

/** Deletes all rows from every application table. */
export async function resetDb(): Promise<void> {
  const pool = await getPool();
  for (const table of TABLES) {
    await pool.request().batch(`DELETE FROM dbo.${table};`);
  }
}

export async function createOffice(): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('lat', sql.Decimal(9, 6), OFFICE.lat)
    .input('lng', sql.Decimal(9, 6), OFFICE.lng)
    .input('radius', sql.Int, OFFICE.radius)
    .query<{ id: number }>(
      `INSERT INTO dbo.Offices (Name, Address, Latitude, Longitude, RadiusMeters)
       OUTPUT INSERTED.OfficeId AS id
       VALUES (N'LEADS Office Geofence', N'123 Aerospace Tech Park, Singapore', @lat, @lng, @radius)`,
    );
  return result.recordset[0]!.id;
}

export interface TestUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  token: string;
}

let userCounter = 0;

export async function createUser(
  officeId: number,
  opts: { role?: Role; name?: string; email?: string; isActive?: boolean; shiftStart?: string } = {},
): Promise<TestUser> {
  userCounter++;
  const role = opts.role ?? 'EMPLOYEE';
  const name = opts.name ?? `Test User${userCounter}`;
  const email = opts.email ?? `user${userCounter}.${Date.now()}@leads-ndt.com`;
  const pool = await getPool();
  const result = await pool
    .request()
    .input('name', sql.NVarChar, name)
    .input('email', sql.NVarChar, email)
    .input('hash', sql.NVarChar, passwordHash)
    .input('role', sql.NVarChar, role)
    .input('officeId', sql.Int, officeId)
    .input('shiftStart', sql.NVarChar, opts.shiftStart ?? '09:00')
    .input('isActive', sql.Bit, opts.isActive ?? true)
    .query<{ id: number }>(
      `INSERT INTO dbo.Users (Name, Email, PasswordHash, Role, OfficeId, ShiftStart, IsActive, Status)
       OUTPUT INSERTED.UserId AS id
       VALUES (@name, @email, @hash, @role, @officeId, CAST(@shiftStart AS TIME(0)), @isActive,
               CASE WHEN @isActive = 1 THEN N'ACTIVE' ELSE N'INACTIVE' END)`,
    );
  const id = result.recordset[0]!.id;
  return { id, name, email, role, token: signAccessToken({ id, role }) };
}

export const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

export async function createTask(opts: {
  assigneeId: number;
  createdBy: number;
  dueDate: string;
  dueTime?: string;
  status?: 'TODO' | 'IN_PROGRESS' | 'COMPLETED' | 'CARRIED_OVER';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH';
  title?: string;
}): Promise<number> {
  const status = opts.status ?? 'TODO';
  const pool = await getPool();
  const result = await pool
    .request()
    .input('title', sql.NVarChar, opts.title ?? 'Inspect landing gear')
    .input('assigneeId', sql.Int, opts.assigneeId)
    .input('createdBy', sql.Int, opts.createdBy)
    .input('priority', sql.NVarChar, opts.priority ?? 'MEDIUM')
    .input('status', sql.NVarChar, status)
    .input('dueUtc', sql.DateTime2(0), combineWorkDateAndTime(opts.dueDate, opts.dueTime ?? '17:00'))
    .input('dueWorkDate', sql.Date, dateParam(opts.dueDate))
    .input('completedUtc', sql.DateTime2(0), status === 'COMPLETED' ? new Date() : null)
    .query<{ id: number }>(
      `INSERT INTO dbo.Tasks (Title, Description, AssigneeId, CreatedBy, Priority, Status, DueUtc, DueWorkDate, CompletedUtc)
       OUTPUT INSERTED.TaskId AS id
       VALUES (@title, N'Test task', @assigneeId, @createdBy, @priority, @status, @dueUtc, @dueWorkDate, @completedUtc)`,
    );
  return result.recordset[0]!.id;
}

export async function createAttendance(opts: {
  userId: number;
  workDate: string;
  clockInUtc: Date;
  clockOutUtc?: Date | null;
  isLate?: boolean;
}): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, opts.userId)
    .input('workDate', sql.Date, dateParam(opts.workDate))
    .input('clockIn', sql.DateTime2(0), opts.clockInUtc)
    .input('clockOut', sql.DateTime2(0), opts.clockOutUtc ?? null)
    .input('isLate', sql.Bit, opts.isLate ?? false)
    .query<{ id: number }>(
      `INSERT INTO dbo.Attendance (UserId, WorkDate, ClockInUtc, ClockOutUtc, InLat, InLng, InAccuracy, InDistanceMeters,
                                   Method, IsLate)
       OUTPUT INSERTED.AttendanceId AS id
       VALUES (@userId, @workDate, @clockIn, @clockOut, 1.417, 103.868, 10, 0, N'GEOFENCE', @isLate)`,
    );
  return result.recordset[0]!.id;
}

export async function scalar<T>(query: string, bind: (r: sql.Request) => void = () => undefined): Promise<T> {
  const pool = await getPool();
  const request = pool.request();
  bind(request);
  const result = await request.query(query);
  return Object.values(result.recordset[0] as Record<string, unknown>)[0] as T;
}

/** A point `meters` north of the office. */
export function pointNorth(meters: number) {
  return { latitude: OFFICE.lat + meters / 111_195, longitude: OFFICE.lng };
}
