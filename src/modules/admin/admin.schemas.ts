import { z } from 'zod';
import { workDateString } from '../../middleware/validate';
import { ROLES } from '../auth/auth.types';

const isoDateTime = z.string().datetime({ offset: true, message: 'must be an ISO-8601 timestamp' });

export const dateQuery = z.object({ date: workDateString.optional() });

export const usersQuery = z.object({ role: z.enum(ROLES).optional() });

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

export const createLeaveBody = z
  .object({
    userId: z.number().int().positive(),
    fromDate: workDateString,
    toDate: workDateString,
    reason: z.string().trim().min(1, 'is required').max(500),
  })
  .refine((v) => v.fromDate <= v.toDate, { message: 'must be on or after fromDate', path: ['toDate'] });

export type ManualAttendanceInput = z.infer<typeof manualAttendanceBody>;
export type CreateLeaveInput = z.infer<typeof createLeaveBody>;
