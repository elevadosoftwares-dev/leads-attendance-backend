import { env } from '../../config/env';
import { fromDateColumn, fromTimeColumn, isUniqueViolation, withTransaction } from '../../db/pool';
import { realtime } from '../../services/realtime.service';
import { AppError } from '../../utils/AppError';
import { percent } from '../../utils/format';
import { haversineMeters } from '../../utils/geo';
import {
  combineWorkDateAndTime,
  computeIsLate,
  currentMonth,
  elapsedMinutes,
  isoUtc,
  monthRange,
  nextWorkDate,
  nowUtc,
  toLocalTime,
  toWorkDate,
  todayWorkDate,
} from '../../utils/time';
import {
  findOfficeForUser,
  toOfficeDto,
  type OfficeDto,
  type OfficeRow,
} from '../offices/offices.repository';
import { toTaskSummary, toTaskSummaryWithAssignee } from '../tasks/tasks.mapper';
import * as tasksRepo from '../tasks/tasks.repository';
import type { TaskSummary } from '../tasks/tasks.types';
import { findUserById } from '../users/users.repository';
import { toAttendanceDto, type AttendanceDto } from './attendance.mapper';
import * as repo from './attendance.repository';
import type { ClockInInput, ClockOutInput } from './attendance.schemas';

export type AttendanceStatus = 'NOT_CLOCKED_IN' | 'CLOCKED_IN' | 'CLOCKED_OUT';

const noOpenShift = () => new AppError(404, 'NO_OPEN_SHIFT', 'You are not clocked in');
const alreadyClockedIn = (message = 'You are already clocked in') =>
  new AppError(409, 'ALREADY_CLOCKED_IN', message);

async function requireOffice(
  userId: number,
  db?: Parameters<typeof findOfficeForUser>[1],
): Promise<OfficeRow> {
  const office = await findOfficeForUser(userId, db);
  if (!office) throw AppError.notFound('No office is assigned to your account');
  return office;
}

/** Distance from the reported fix to the office; the client's own distance is never trusted. */
function distanceToOffice(input: { latitude: number; longitude: number }, office: OfficeRow): number {
  return haversineMeters(input.latitude, input.longitude, Number(office.Latitude), Number(office.Longitude));
}

function assertNotMocked(input: { isMocked: boolean }): void {
  if (input.isMocked) {
    throw new AppError(
      422,
      'MOCK_LOCATION',
      'Mock locations are not allowed. Disable any location-spoofing app.',
    );
  }
}

function assertAccuracy(input: { accuracy: number }): void {
  if (input.accuracy > env.MAX_GPS_ACCURACY_METERS) {
    throw new AppError(422, 'LOW_ACCURACY', 'GPS accuracy is too low. Move to an open area and try again.', {
      accuracy: input.accuracy,
      maxAccuracy: env.MAX_GPS_ACCURACY_METERS,
    });
  }
}

function assertInsideGeofence(distance: number, office: OfficeRow): void {
  if (distance > office.RadiusMeters) {
    throw new AppError(422, 'OUTSIDE_GEOFENCE', 'You are outside the office geofence', {
      distanceMeters: Math.round(distance),
      radiusMeters: office.RadiusMeters,
    });
  }
}

/** Order matters: mocked location, then accuracy, then distance. */
export function validateGeofenceFix(input: ClockInInput, office: OfficeRow): number {
  assertNotMocked(input);
  assertAccuracy(input);
  const distance = distanceToOffice(input, office);
  assertInsideGeofence(distance, office);
  return distance;
}

async function attendanceStatus(userId: number, today: string) {
  const open = await repo.findOpenShift(userId);
  if (open) return { status: 'CLOCKED_IN' as const, record: open };
  const todays = await repo.findAttendanceByUserAndDate(userId, today);
  if (todays) return { status: 'CLOCKED_OUT' as const, record: todays };
  return { status: 'NOT_CLOCKED_IN' as const, record: null };
}

export interface TodayView {
  date: string;
  office: OfficeDto;
  attendance: { status: AttendanceStatus; record: AttendanceDto | null };
  tasks: { total: number; completed: number; preview: TaskSummary[] };
}

export async function getToday(userId: number): Promise<TodayView> {
  const date = todayWorkDate();
  const [office, attendance, tasks] = await Promise.all([
    requireOffice(userId),
    attendanceStatus(userId, date),
    tasksRepo.listTasksForAssigneeOnDate(userId, date),
  ]);
  return {
    date,
    office: toOfficeDto(office),
    attendance: {
      status: attendance.status,
      record: attendance.record ? toAttendanceDto(attendance.record) : null,
    },
    tasks: {
      total: tasks.length,
      completed: tasks.filter((t) => t.Status === 'COMPLETED').length,
      // Already ordered with unfinished tasks first.
      preview: tasks.slice(0, 3).map(toTaskSummary),
    },
  };
}

export async function clockIn(userId: number, input: ClockInInput): Promise<AttendanceDto> {
  const user = await findUserById(userId);
  if (!user || !user.IsActive) throw AppError.unauthorized('Account is not active');

  if (await repo.findOpenShift(userId)) throw alreadyClockedIn();

  const office = await requireOffice(userId);
  const distance = validateGeofenceFix(input, office);

  const now = nowUtc();
  const workDate = toWorkDate(now);
  if (await repo.findAttendanceByUserAndDate(userId, workDate)) {
    throw alreadyClockedIn('You have already completed a shift today');
  }

  const isLate = computeIsLate(now, workDate, fromTimeColumn(user.ShiftStart));
  let attendanceId: number;
  try {
    attendanceId = await repo.insertGeofenceClockIn(userId, workDate, now, isLate, {
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: input.accuracy,
      distanceMeters: distance,
    });
  } catch (err) {
    // A concurrent clock-in won the race: the open-shift / one-per-day unique indexes reject this one.
    if (isUniqueViolation(err)) throw alreadyClockedIn();
    throw err;
  }

  const record = await repo.findAttendanceById(attendanceId);
  realtime.attendanceChanged(userId);
  return toAttendanceDto(record!);
}

export async function getCurrentShift(userId: number) {
  const open = await repo.findOpenShift(userId);
  if (!open) throw noOpenShift();
  const tasks = await tasksRepo.listTasksForAssigneeOnDate(userId, fromDateColumn(open.WorkDate));
  return {
    attendance: toAttendanceDto(open),
    elapsedMinutes: elapsedMinutes(open.ClockInUtc, new Date()),
    tasks: tasks.map(toTaskSummary),
  };
}

/**
 * Submits the daily report and clocks out, atomically: report insert, task carry-over and the
 * shift close either all commit or all roll back.
 */
export async function clockOut(
  userId: number,
  input: ClockOutInput,
): Promise<{ attendance: AttendanceDto; reportId: number }> {
  const now = nowUtc();
  const carryOverIds = [...new Set(input.carryOverTaskIds)];

  const { attendanceId, reportId } = await withTransaction(async (tx) => {
    const open = await repo.findOpenShift(userId, tx, { lock: true });
    if (!open) throw noOpenShift();

    // Location is always recorded. Mocked and inaccurate fixes are always rejected;
    // the geofence itself is only enforced when CLOCK_OUT_REQUIRES_GEOFENCE=true.
    const office = await requireOffice(userId, tx);
    assertNotMocked(input);
    assertAccuracy(input);
    const distance = distanceToOffice(input, office);
    if (env.CLOCK_OUT_REQUIRES_GEOFENCE) assertInsideGeofence(distance, office);

    const reportId = await repo.insertDailyReport(
      {
        attendanceId: open.AttendanceId,
        userId,
        summary: input.summary,
        blockers: input.blockers,
        notes: input.notes,
        submittedUtc: now,
      },
      tx,
    );

    if (carryOverIds.length > 0) {
      const shiftDate = fromDateColumn(open.WorkDate);
      const tasks = await tasksRepo.lockTasksByIds(carryOverIds, tx);
      const found = new Map(tasks.map((t) => [t.TaskId, t]));
      const missing = carryOverIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw AppError.validation('Some tasks to carry over do not exist', {
          fields: [{ field: 'carryOverTaskIds', message: `unknown task ids: ${missing.join(', ')}` }],
        });
      }
      if (tasks.some((t) => t.AssigneeId !== userId)) {
        throw AppError.forbidden('You can only carry over your own tasks');
      }
      const completed = tasks.filter((t) => t.Status === 'COMPLETED').map((t) => t.TaskId);
      if (completed.length > 0) {
        throw AppError.validation('Completed tasks cannot be carried over', {
          fields: [{ field: 'carryOverTaskIds', message: `already completed: ${completed.join(', ')}` }],
        });
      }
      const nextDate = nextWorkDate(shiftDate);
      for (const task of tasks) {
        // Same local time of day, on the next work day (never earlier than the current due date).
        const currentDue = fromDateColumn(task.DueWorkDate);
        const dueDate = currentDue > nextDate ? currentDue : nextDate;
        const dueUtc = combineWorkDateAndTime(dueDate, toLocalTime(task.DueUtc));
        await tasksRepo.carryOverTask(task.TaskId, dueUtc, dueDate, tx);
      }
    }

    await repo.closeShift(
      open.AttendanceId,
      now,
      {
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy,
        distanceMeters: distance,
      },
      tx,
    );
    return { attendanceId: open.AttendanceId, reportId };
  });

  const record = await repo.findAttendanceById(attendanceId);
  realtime.attendanceChanged(userId);
  if (carryOverIds.length > 0) {
    const rows = await Promise.all(carryOverIds.map((id) => tasksRepo.findTaskById(id)));
    realtime.tasksChanged(rows.filter((r) => r !== null).map(toTaskSummaryWithAssignee));
  }
  return { attendance: toAttendanceDto(record!), reportId };
}

export async function getHistory(userId: number, month: string = currentMonth()) {
  const { from, to } = monthRange(month);
  const [rows, taskCounts] = await Promise.all([
    repo.listHistory(userId, from, to),
    tasksRepo.taskCountsInRange(userId, from, to),
  ]);
  const closed = rows.filter((r) => r.DurationMinutes !== null);
  const avgMinutes =
    closed.length === 0
      ? 0
      : Math.round(closed.reduce((sum, r) => sum + (r.DurationMinutes ?? 0), 0) / closed.length);

  return {
    month,
    stats: { avgMinutes, taskCompletionRate: percent(taskCounts.completed, taskCounts.total) },
    days: rows.map((r) => ({
      workDate: fromDateColumn(r.WorkDate),
      clockInUtc: isoUtc(r.ClockInUtc),
      clockOutUtc: isoUtc(r.ClockOutUtc),
      durationMinutes: r.DurationMinutes,
      method: r.Method,
      isLate: r.IsLate,
      tasksCompleted: r.TasksCompleted,
      tasksTotal: r.TasksTotal,
    })),
  };
}
