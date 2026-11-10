import { fromTimeColumn, isUniqueViolation, withTransaction } from '../../db/pool';
import { realtime } from '../../services/realtime.service';
import { AppError } from '../../utils/AppError';
import { percent } from '../../utils/format';
import { addDaysToWorkDate, computeIsLate, isoUtc, toWorkDate, todayWorkDate } from '../../utils/time';
import { toAttendanceDto, type AttendanceDto } from '../attendance/attendance.mapper';
import * as attendanceRepo from '../attendance/attendance.repository';
import { taskCountsOnDate } from '../tasks/tasks.repository';
import { userRef, type UserRef } from '../users/users.mapper';
import { findOfficeForUser } from '../offices/offices.repository';
import { findUserById } from '../users/users.repository';
import * as repo from './admin.repository';
import type { ManualAttendanceInput } from './admin.schemas';

export type LiveStatus = 'IN_OFFICE' | 'LATE' | 'ON_LEAVE' | 'ABSENT' | 'CLOCKED_OUT';

export interface LiveAttendanceRow {
  user: UserRef;
  status: LiveStatus;
  clockInUtc: string | null;
  clockOutUtc: string | null;
  isLate: boolean;
}

export interface Overview {
  totalEmployees: number;
  inOffice: number;
  inOfficePct: number;
  clockedOut: number;
  late: { count: number; names: string[] };
  onLeave: number;
  taskCompletionPct: number;
  /** Null when today or yesterday has no tasks due, so there is nothing to compare. */
  taskCompletionDeltaPct: number | null;
}

/** CLOCKED_OUT once the shift is closed; LATE or IN_OFFICE while it is open; then ON_LEAVE, ABSENT. */
export function liveStatusOf(row: repo.LiveRow): LiveStatus {
  if (row.ClockInUtc) {
    if (row.ClockOutUtc) return 'CLOCKED_OUT';
    return row.IsLate ? 'LATE' : 'IN_OFFICE';
  }
  return row.OnLeave ? 'ON_LEAVE' : 'ABSENT';
}

function toLiveRow(row: repo.LiveRow): LiveAttendanceRow {
  return {
    user: userRef(row.UserId, row.Name),
    status: liveStatusOf(row),
    clockInUtc: isoUtc(row.ClockInUtc),
    clockOutUtc: isoUtc(row.ClockOutUtc),
    isLate: row.IsLate === true,
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
  // inOffice = open shifts only; shifts already closed today are counted in clockedOut.
  const inOffice = rows.filter((r) => r.ClockInUtc !== null && r.ClockOutUtc === null).length;
  const clockedOut = rows.filter((r) => r.ClockInUtc !== null && r.ClockOutUtc !== null).length;
  const late = rows.filter((r) => r.IsLate);
  const taskCompletionPct = percent(todayTasks.completed, todayTasks.total);
  return {
    totalEmployees: rows.length,
    inOffice,
    inOfficePct: percent(inOffice, rows.length),
    clockedOut,
    late: { count: late.length, names: late.map((r) => r.Name) },
    onLeave: rows.filter((r) => r.OnLeave).length,
    taskCompletionPct,
    taskCompletionDeltaPct:
      todayTasks.total === 0 || yesterdayTasks.total === 0
        ? null
        : taskCompletionPct - percent(yesterdayTasks.completed, yesterdayTasks.total),
  };
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
  const office = await findOfficeForUser(input.userId);
  if (!office) throw AppError.notFound('No office is assigned to this user');
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
          isLate: computeIsLate(
            clockIn,
            input.workDate,
            fromTimeColumn(user.ShiftStart),
            office.LateGraceMinutes,
          ),
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
