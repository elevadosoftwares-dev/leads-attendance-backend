import { z } from 'zod';
import { workDateString } from '../../middleware/validate';
import { LEAVE_STATUSES } from './leaves.repository';

const reason = z.string().trim().min(1, 'is required').max(500);
const note = z.string().trim().max(500).optional();

const range = { fromDate: workDateString, toDate: workDateString, reason };
const ordered = (v: { fromDate: string; toDate: string }) => v.fromDate <= v.toDate;
const orderedError = { message: 'must be on or after fromDate', path: ['toDate'] };

/** An admin records leave for an employee; it is approved at once. */
export const createLeaveBody = z
  .object({ ...range, userId: z.number().int().positive() })
  .refine(ordered, orderedError);

/** An employee asks for leave; it waits for an admin. */
export const requestLeaveBody = z.object(range).refine(ordered, orderedError);

/** `date`: approved leave covering that day. Otherwise leave in `status` (default APPROVED). */
export const listLeavesQuery = z.object({
  date: workDateString.optional(),
  status: z.enum(LEAVE_STATUSES).optional(),
});

export const reviewLeaveBody = z.object({ note });

export type CreateLeaveInput = z.infer<typeof createLeaveBody>;
export type RequestLeaveInput = z.infer<typeof requestLeaveBody>;
export type ListLeavesQuery = z.infer<typeof listLeavesQuery>;
