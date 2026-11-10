import { z } from 'zod';
import { timeString } from '../../middleware/validate';
import { isValidTimeZone } from '../../utils/time';

export const updateOfficeBody = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    address: z.string().trim().min(1).max(300).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    radiusMeters: z.number().int().min(10).max(5000).optional(),
    defaultShiftStart: timeString.optional(),
    defaultShiftEnd: timeString.optional(),
    lateGraceMinutes: z.number().int().min(0).max(240).optional(),
    timezone: z
      .string()
      .trim()
      .max(64)
      .refine(isValidTimeZone, { message: 'unknown time zone (use an IANA name such as Asia/Kolkata)' })
      .optional(),
    /** Also give every user the office's default shift (start and end, after this update). */
    applyShiftToAllUsers: z.boolean().default(false),
  })
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'applyShiftToAllUsers' && x !== undefined), {
    message: 'provide at least one field',
  })
  .refine(
    (v) => !v.applyShiftToAllUsers || v.defaultShiftStart !== undefined || v.defaultShiftEnd !== undefined,
    { message: 'requires defaultShiftStart or defaultShiftEnd', path: ['applyShiftToAllUsers'] },
  );

export type UpdateOfficeInput = z.infer<typeof updateOfficeBody>;
