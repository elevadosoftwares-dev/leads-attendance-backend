import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { adminAnnouncementsRouter } from '../announcements/announcements.routes';
import { adminTasksRouter } from '../tasks/tasks.routes';
import * as controller from './admin.controller';
import { createLeaveBody, dateQuery, manualAttendanceBody, usersQuery } from './admin.schemas';

/** Everything under /admin requires an ADMIN access token. */
export const adminRouter = Router();

adminRouter.use(authenticate, requireRole('ADMIN'));
adminRouter.use('/tasks', adminTasksRouter);
adminRouter.use('/announcements', adminAnnouncementsRouter);

adminRouter.get('/overview', asyncHandler(controller.overview));
adminRouter.get('/attendance/live', asyncHandler(controller.liveAttendance));
adminRouter.post(
  '/attendance/manual',
  validate({ body: manualAttendanceBody }),
  asyncHandler(controller.manualAttendance),
);
adminRouter.get('/users', validate({ query: usersQuery }), asyncHandler(controller.users));
adminRouter.get('/reports', validate({ query: dateQuery }), asyncHandler(controller.reports));
adminRouter.post('/leaves', validate({ body: createLeaveBody }), asyncHandler(controller.createLeave));
adminRouter.get('/leaves', validate({ query: dateQuery }), asyncHandler(controller.listLeaves));
