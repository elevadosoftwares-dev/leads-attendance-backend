import { z } from 'zod';
import { paginationQuery, timeString, workDateString } from '../../middleware/validate';
import { PRIORITIES, TASK_STATUSES } from './tasks.types';

export const listTasksQuery = z.object({
  date: workDateString.optional(),
});

export const updateStatusBody = z.object({
  status: z.enum(['IN_PROGRESS', 'COMPLETED']),
});

const taskFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000),
  assigneeId: z.number().int().positive(),
  priority: z.enum(PRIORITIES),
  dueDate: workDateString,
  dueTime: timeString,
  notify: z.boolean(),
};

export const createTaskBody = z.object({
  ...taskFields,
  description: taskFields.description.default(''),
  notify: taskFields.notify.default(false),
});

export const updateTaskBody = z
  .object(taskFields)
  .partial()
  .refine((v) => Object.keys(v).some((k) => k !== 'notify'), {
    message: 'At least one field must be provided',
  });

export const adminListQuery = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  date: workDateString.optional(),
  ...paginationQuery,
});

export type CreateTaskInput = z.infer<typeof createTaskBody>;
export type UpdateTaskInput = z.infer<typeof updateTaskBody>;
export type AdminListQuery = z.infer<typeof adminListQuery>;
