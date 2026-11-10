import { z } from 'zod';
import { workDateString } from '../../middleware/validate';

const isoDateTime = z.string().datetime({ offset: true, message: 'must be an ISO-8601 timestamp' });

export const dateQuery = z.object({ date: workDateString.optional() });

export const manualAttendanceBody = z
  .object({
    userId: z.number().int().positive(),
    workDate: workDateString,
    clockInUtc: isoDateTime,
    clockOutUtc: isoDateTime.nullish(),
    reason: z.string().trim().min(1, 'is required').max(500),
  })
  .refine((v) => !v.clockOutUtc || Date.parse(v.clockOutUtc) > Date.parse(v.clockInUtc), {
    message: 'must be after clockInUtc',
    path: ['clockOutUtc'],
  });

export type ManualAttendanceInput = z.infer<typeof manualAttendanceBody>;
