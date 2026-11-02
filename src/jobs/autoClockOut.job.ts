import { fromDateColumn, withTransaction } from '../db/pool';
import * as attendanceRepo from '../modules/attendance/attendance.repository';
import { realtime } from '../services/realtime.service';
import { logger } from '../utils/logger';
import { combineWorkDateAndTime, toWorkDate } from '../utils/time';

export const AUTO_CLOCK_OUT_SUMMARY = 'Auto clock-out: no report submitted';
const AUTO_CLOCK_OUT_TIME = '23:59';

/**
 * Daily 23:59 SG: closes every shift still open at 23:59 of its work date and writes a placeholder
 * daily report. Shifts left open from earlier days (e.g. server downtime) are closed at 23:59 of
 * their own work date. Returns the closed attendance ids.
 */
export async function runAutoClockOut(asOf: Date = new Date()): Promise<number[]> {
  const open = await attendanceRepo.listOpenShiftsUpTo(toWorkDate(asOf));
  const closed: number[] = [];
  const affectedUsers = new Set<number>();

  for (const shift of open) {
    const workDate = fromDateColumn(shift.WorkDate);
    const cutoff = combineWorkDateAndTime(workDate, AUTO_CLOCK_OUT_TIME);
    if (cutoff.getTime() > asOf.getTime()) continue; // the day isn't over yet
    const clockOut = cutoff < shift.ClockInUtc ? shift.ClockInUtc : cutoff;

    try {
      const didClose = await withTransaction(async (tx) => {
        const current = await attendanceRepo.findOpenShift(shift.UserId, tx, { lock: true });
        if (!current || current.AttendanceId !== shift.AttendanceId) return false; // closed meanwhile
        if (!(await attendanceRepo.hasDailyReport(shift.AttendanceId, tx))) {
          await attendanceRepo.insertDailyReport(
            {
              attendanceId: shift.AttendanceId,
              userId: shift.UserId,
              summary: AUTO_CLOCK_OUT_SUMMARY,
              blockers: null,
              notes: null,
              submittedUtc: clockOut,
            },
            tx,
          );
        }
        await attendanceRepo.closeShift(shift.AttendanceId, clockOut, null, tx);
        return true;
      });
      if (didClose) {
        closed.push(shift.AttendanceId);
        affectedUsers.add(shift.UserId);
        logger.info(
          { attendanceId: shift.AttendanceId, userId: shift.UserId, workDate },
          'Auto clock-out: shift closed',
        );
      }
    } catch (err) {
      logger.error({ err, attendanceId: shift.AttendanceId }, 'Auto clock-out failed for shift');
    }
  }

  if (affectedUsers.size > 0) realtime.attendanceChanged(...affectedUsers);
  logger.info({ count: closed.length }, 'Auto clock-out job finished');
  return closed;
}
