import { z } from 'zod';

export const locationFields = {
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000),
  isMocked: z.boolean(),
};

export const clockInBody = z.object(locationFields);

const optionalText = z
  .string()
  .trim()
  .max(2000)
  .nullish()
  .transform((v) => (v ? v : null));

export const clockOutBody = z.object({
  ...locationFields,
  summary: z.string().trim().min(1, 'is required').max(2000),
  blockers: optionalText,
  notes: optionalText,
  carryOverTaskIds: z.array(z.number().int().positive()).max(100).default([]),
});

export const historyQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM')
    .optional(),
});

export type ClockInInput = z.infer<typeof clockInBody>;
export type ClockOutInput = z.infer<typeof clockOutBody>;
