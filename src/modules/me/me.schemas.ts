import { z } from 'zod';

export const deviceTokenBody = z.object({
  fcmToken: z.string().trim().min(10).max(512),
  platform: z.enum(['android', 'ios']),
  /** Deliver this device's notifications without sound (the app's notification setting). */
  silent: z.boolean().default(false),
});
