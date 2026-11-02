import { z } from 'zod';
import { paginationQuery } from '../../middleware/validate';

export const ANNOUNCEMENT_CATEGORIES = ['SAFETY', 'GENERAL', 'EVENTS'] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export const listAnnouncementsQuery = z.object({
  // An empty `?category=` means "all", like omitting it.
  category: z.preprocess((v) => (v === '' ? undefined : v), z.enum(ANNOUNCEMENT_CATEGORIES).optional()),
  ...paginationQuery,
});

const fields = {
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  category: z.enum(ANNOUNCEMENT_CATEGORIES),
  isPinned: z.boolean(),
  notify: z.boolean(),
};

export const createAnnouncementBody = z.object({
  ...fields,
  isPinned: fields.isPinned.default(false),
  notify: fields.notify.default(false),
});

export const updateAnnouncementBody = z
  .object(fields)
  .partial()
  .refine((v) => Object.keys(v).some((k) => k !== 'notify'), {
    message: 'At least one field must be provided',
  });

export type ListAnnouncementsQuery = z.infer<typeof listAnnouncementsQuery>;
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementBody>;
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementBody>;
