import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../utils/logger';
import { companyTimezone, onCompanyTimezoneChange } from '../utils/time';
import { runAutoClockOut } from './autoClockOut.job';
import { runShiftReminder } from './shiftReminder.job';

/**
 * Schedules background jobs in the company timezone, rescheduling them when the super admin changes it. Returns a
 * function that stops them.
 */
export function startJobs(): () => void {
  const guard = (name: string, job: () => Promise<unknown>) => async () => {
    try {
      await job();
    } catch (err) {
      logger.error({ err }, `Job failed: ${name}`);
    }
  };

  const schedule = (timezone: string): ScheduledTask[] => {
    const options = { timezone, noOverlap: true };
    const tasks = [
      cron.schedule('45 8 * * 1-5', guard('shift-reminder', runShiftReminder), {
        ...options,
        name: 'shift-reminder',
      }),
      cron.schedule(
        '59 23 * * *',
        guard('auto-clock-out', () => runAutoClockOut()),
        {
          ...options,
          name: 'auto-clock-out',
        },
      ),
    ];
    logger.info({ timezone }, 'Scheduled jobs: shift reminder (08:45 Mon–Fri), auto clock-out (23:59 daily)');
    return tasks;
  };

  const stop = (tasks: ScheduledTask[]) => {
    for (const task of tasks) void task.stop();
  };

  let tasks = schedule(companyTimezone());
  const unsubscribe = onCompanyTimezoneChange((timezone) => {
    stop(tasks);
    tasks = schedule(timezone);
  });

  return () => {
    unsubscribe();
    stop(tasks);
  };
}
