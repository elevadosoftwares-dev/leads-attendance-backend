import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);

export const loginBody = z.object({
  email,
  password: z.string().min(1).max(128),
});

export const refreshBody = z.object({
  refreshToken: z.string().min(1).max(200),
});

export const forgotPasswordBody = z.object({ email });

export const resetPasswordBody = z.object({
  token: z.string().min(1).max(200),
  newPassword: z
    .string()
    .min(8, 'must be at least 8 characters')
    .max(128)
    .regex(/[A-Za-z]/, 'must contain a letter')
    .regex(/\d/, 'must contain a number'),
});
