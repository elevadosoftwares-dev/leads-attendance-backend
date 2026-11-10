import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const refreshBody = z.object({
  refreshToken: z.string().min(1).max(200),
});

export const forgotPasswordBody = z.object({ email: emailSchema });

export const newPassword = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'must contain a letter')
  .regex(/\d/, 'must contain a number');

export const personName = z.string().trim().min(2, 'must be at least 2 characters').max(150);

export const resetPasswordBody = z.object({
  token: z.string().min(1).max(200),
  newPassword,
});

export const signupBody = z.object({ name: personName, email: emailSchema, password: newPassword });

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword,
});
