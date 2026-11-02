import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { idParam, validate } from '../../middleware/validate';
import * as controller from './announcements.controller';
import {
  createAnnouncementBody,
  listAnnouncementsQuery,
  updateAnnouncementBody,
} from './announcements.schemas';

/** Readable by any signed-in user, mounted at /announcements. */
export const announcementsRouter = Router();

announcementsRouter.use(authenticate);
announcementsRouter.get('/', validate({ query: listAnnouncementsQuery }), asyncHandler(controller.list));
announcementsRouter.get('/:id', validate({ params: idParam }), asyncHandler(controller.get));

/** Mounted at /admin/announcements (the admin router applies requireRole('ADMIN')). */
export const adminAnnouncementsRouter = Router();

adminAnnouncementsRouter.post(
  '/',
  validate({ body: createAnnouncementBody }),
  asyncHandler(controller.create),
);
adminAnnouncementsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateAnnouncementBody }),
  asyncHandler(controller.update),
);
adminAnnouncementsRouter.delete('/:id', validate({ params: idParam }), asyncHandler(controller.remove));
