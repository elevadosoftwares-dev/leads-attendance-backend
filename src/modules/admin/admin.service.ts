import { fromDateColumn, fromTimeColumn, isUniqueViolation, withTransaction } from '../../db/pool';
import { realtime } from '../../services/realtime.service';
import { AppError } from '../../utils/AppError';
import { initialsOf, percent } from '../../utils/format';
import { addDaysToWorkDate, computeIsLate, isoUtc, toWorkDate, todayWorkDate } from '../../utils/time';
import type { Role } from '../auth/auth.types';
import { toAttendanceDto, type AttendanceDto } from '../attendance/attendance.mapper';
import * as attendanceRepo from '../attendance/attendance.repository';
import { taskCountsOnDate } from '../tasks/tasks.repository';
import { userRef, type UserRef } from '../users/users.mapper';
import { findUserById, listActiveUsers } from '../users/users.repository';
import * as repo from './admin.repository';
import type { CreateLeaveInput, ManualAttendanceInput } from './admin.schemas';

export type LiveStatus = 'IN_OFFICE' | 'LATE' | 'ON_LEAVE' | 'ABSENT' | 'CLOCKED_OUT';

export interface LiveAttendanceRow {
  user: UserRef;
  status: LiveStatus;
  clockInUtc: string | null;
}

export interface Overview {
  totalEmployees: number;
  inOffice: number;
  inOfficePct: number;
  late: { count: number; names: string[] };
  onLeave: number;
  taskCompletionPct: number;
  taskCompletionDeltaPct: number;
}

/** LATE if clocked in late; IN_OFFICE if on time and still open; then CLOCKED_OUT, ON_LEAVE, ABSENT. */
export function liveStatusOf(row: repo.LiveRow): LiveStatus {
  if (row.ClockInUtc) {
    if (row.IsLate) return 'LATE';
    return row.ClockOutUtc ? 'CLOCKED_OUT' : 'IN_OFFICE';
  }
  return row.OnLeave ? 'ON_LEAVE' : 'ABSENT';
}

function toLiveRow(row: repo.LiveRow): LiveAttendanceRow {
  return {
    user: userRef(row.UserId, row.Name),
    status: liveStatusOf(row),
    clockInUtc: isoUtc(row.ClockInUtc),
  };
}

export async function getLiveAttendance(): Promise<LiveAttendanceRow[]> {
  return (await repo.listLiveRows(todayWorkDate())).map(toLiveRow);
}

/** One live row (used for `attendance:updated`); null for non-employees. */
export async function getLiveRow(userId: number): Promise<LiveAttendanceRow | null> {
  const [row] = await repo.listLiveRows(todayWorkDate(), userId);
  return row ? toLiveRow(row) : null;
}

export async function getOverview(): Promise<Overview> {
  const today = todayWorkDate();
  const [rows, todayTasks, yesterdayTasks] = await Promise.all([
    repo.listLiveRows(today),
    taskCountsOnDate(today),
    taskCountsOnDate(addDaysToWorkDate(today, -1)),
  ]);
  // inOffice = open shifts plus shifts already clocked out today.
  const inOffice = rows.filter((r) => r.ClockInUtc !== null).length;
  const late = rows.filter((r) => r.IsLate);
  const taskCompletionPct = percent(todayTasks.completed, todayTasks.total);
  return {
    totalEmployees: rows.length,
    inOffice,
    inOfficePct: percent(inOffice, rows.length),
    late: { count: late.length, names: late.map((r) => r.Name) },
    onLeave: rows.filter((r) => r.OnLeave).length,
    taskCompletionPct,
    taskCompletionDeltaPct: taskCompletionPct - percent(yesterdayTasks.completed, yesterdayTasks.total),
  };
}

export async function listUsers(role?: Role) {
  const users = await listActiveUsers(role);
  return users.map((u) => ({ id: u.UserId, name: u.Name, initials: initialsOf(u.Name), role: u.Role }));
}

async function requireEmployee(userId: number) {
  const user = await findUserById(userId);
  if (!user || !user.IsActive || user.Role !== 'EMPLOYEE') {
    throw AppError.validation('User must be an active employee', {
      fields: [{ field: 'userId', message: 'must be an active employee' }],
    });
  }
  return user;
}

const toSeconds = (iso: string) => new Date(Math.floor(Date.parse(iso) / 1000) * 1000);

export async function addManualAttendance(
  adminId: number,
  input: ManualAttendanceInput,
): Promise<AttendanceDto> {
  const user = await requireEmployee(input.userId);
  const clockIn = toSeconds(input.clockInUtc);
  const clockOut = input.clockOutUtc ? toSeconds(input.clockOutUtc) : null;

  if (toWorkDate(clockIn) !== input.workDate) {
    throw AppError.validation('clockInUtc must fall on workDate (Singapore time)', {
      fields: [{ field: 'clockInUtc', message: `falls on ${toWorkDate(clockIn)}, not ${input.workDate}` }],
    });
  }
  const now = Date.now();
  if (clockIn.getTime() > now || (clockOut && clockOut.getTime() > now)) {
    throw AppError.validation('Manual attendance cannot be in the future', {
      fields: [
        { field: clockIn.getTime() > now ? 'clockInUtc' : 'clockOutUtc', message: 'is in the future' },
      ],
    });
  }

  const overlap = () =>
    new AppError(409, 'ALREADY_CLOCKED_IN', 'An attendance record already exists for this user and date', {
      userId: input.userId,
      workDate: input.workDate,
    });

  let attendanceId: number;
  try {
    attendanceId = await withTransaction(async (tx) => {
      if (await attendanceRepo.findAttendanceByUserAndDate(input.userId, input.workDate, tx)) throw overlap();
      return attendanceRepo.insertManualAttendance(
        {
          userId: input.userId,
          workDate: input.workDate,
          clockInUtc: clockIn,
          clockOutUtc: clockOut,
          isLate: computeIsLate(clockIn, input.workDate, fromTimeColumn(user.ShiftStart)),
          reason: input.reason,
          createdBy: adminId,
        },
        tx,
      );
    });
  } catch (err) {
    // Same date inserted concurrently, or an open record while the user already has an open shift.
    if (isUniqueViolation(err)) throw overlap();
    throw err;
  }

  realtime.attendanceChanged(input.userId);
  return toAttendanceDto((await attendanceRepo.findAttendanceById(attendanceId))!);
}

export async function listReports(date: string = todayWorkDate()) {
  const rows = await repo.listReports(date);
  return rows.map((r) => ({
    reportId: r.ReportId,
    user: userRef(r.UserId, r.Name),
    summary: r.Summary,
    blockers: r.Blockers,
    notes: r.Notes,
    submittedUtc: isoUtc(r.SubmittedUtc),
    durationMinutes: r.DurationMinutes,
  }));
}

export interface LeaveDto {
  id: number;
  userId: number;
  user: UserRef;
  fromDate: string;
  toDate: string;
  reason: string;
  createdUtc: string;
  createdBy: { id: number; name: string };
}

function toLeaveDto(row: repo.LeaveRow): LeaveDto {
  return {
    id: row.LeaveId,
    userId: row.UserId,
    user: userRef(row.UserId, row.UserName),
    fromDate: fromDateColumn(row.FromDate),
    toDate: fromDateColumn(row.ToDate),
    reason: row.Reason,
    createdUtc: isoUtc(row.CreatedUtc),
    createdBy: { id: row.CreatedBy, name: row.CreatedByName },
  };
}

export async function createLeave(adminId: number, input: CreateLeaveInput): Promise<LeaveDto> {
  await requireEmployee(input.userId);
  const leaveId = await withTransaction(async (tx) => {
    if (await repo.hasOverlappingLeave(input.userId, input.fromDate, input.toDate, tx)) {
      throw AppError.validation('This leave overlaps an existing leave for the user', {
        fields: [{ field: 'fromDate', message: 'overlaps an existing leave' }],
      });
    }
    return repo.insertLeave({ ...input, createdBy: adminId }, tx);
  });
  const today = todayWorkDate();
  if (input.fromDate <= today && today <= input.toDate) realtime.attendanceChanged(input.userId);
  return toLeaveDto((await repo.findLeave(leaveId))!);
}

export async function listLeaves(date: string = todayWorkDate()): Promise<LeaveDto[]> {
  return (await repo.listLeavesCovering(date)).map(toLeaveDto);
}
