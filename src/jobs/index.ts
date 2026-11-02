import cron from 'node-cron';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { runAutoClockOut } from './autoClockOut.job';
import { runShiftReminder } from './shiftReminder.job';

/** Schedules background jobs in the company timezone. Returns a function that stops them. */
export function startJobs(): () => void {
  const options = { timezone: env.APP_TIMEZONE, noOverlap: true };
  const guard = (name: string, job: () => Promise<unknown>) => async () => {
    try {
      await job();
    } catch (err) {
      logger.error({ err }, `Job failed: ${name}`);
    }
  };

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
  logger.info(
    { timezone: env.APP_TIMEZONE },
    'Scheduled jobs: shift reminder (08:45 Mon–Fri), auto clock-out (23:59 daily)',
  );

  return () => {
    for (const task of tasks) void task.stop();
  };
}
