import { listLiveRows } from '../modules/admin/admin.repository';
import { pushService } from '../services/push.service';
import { logger } from '../utils/logger';
import { todayWorkDate } from '../utils/time';

/** Weekdays 08:45 SG: remind employees who haven't clocked in (and aren't on leave) to do so. */
export async function runShiftReminder(): Promise<number[]> {
  const rows = await listLiveRows(todayWorkDate());
  const userIds = rows.filter((r) => r.ClockInUtc === null && !r.OnLeave).map((r) => r.UserId);
  if (userIds.length > 0) {
    await pushService.notifyUsers(userIds, {
      title: 'Your shift starts soon',
      body: 'Remember to clock in when you arrive at the office.',
      data: { type: 'SHIFT_REMINDER' },
    });
  }
  logger.info({ count: userIds.length }, 'Shift reminder job finished');
  return userIds;
}
