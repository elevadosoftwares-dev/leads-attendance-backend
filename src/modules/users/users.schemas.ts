import { z } from 'zod';
import { timeString } from '../../middleware/validate';
import { emailSchema, newPassword, personName } from '../auth/auth.schemas';
import { ASSIGNABLE_ROLES, ROLES } from '../auth/auth.types';
import { USER_STATUSES } from './users.repository';

export const listUsersQuery = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).default('ACTIVE'),
});

export const createUserBody = z.object({
  name: personName,
  email: emailSchema,
  password: newPassword,
  role: z.enum(ASSIGNABLE_ROLES),
  /** Super admin only; default to the office's default shift start and end. */
  shiftStart: timeString.optional(),
  shiftEnd: timeString.optional(),
});

export const updateUserBody = z
  .object({
    name: personName.optional(),
    role: z.enum(ASSIGNABLE_ROLES).optional(),
    shiftStart: timeString.optional(),
    shiftEnd: timeString.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'provide at least one field' });

export const approveUserBody = z.object({
  shiftStart: timeString.optional(),
  shiftEnd: timeString.optional(),
});

export type CreateUserInput = z.infer<typeof createUserBody>;
export type UpdateUserInput = z.infer<typeof updateUserBody>;
export type ApproveUserInput = z.infer<typeof approveUserBody>;
