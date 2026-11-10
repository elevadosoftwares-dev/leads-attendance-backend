import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { adminAnnouncementsRouter } from '../announcements/announcements.routes';
import { adminLeavesRouter } from '../leaves/leaves.routes';
import { adminOfficeRouter } from '../offices/offices.routes';
import { adminTasksRouter } from '../tasks/tasks.routes';
import { adminUsersRouter } from '../users/users.routes';
import * as controller from './admin.controller';
import { dateQuery, manualAttendanceBody } from './admin.schemas';

/** Everything under /admin requires an ADMIN access token. */
export const adminRouter = Router();

adminRouter.use(authenticate, requireRole('ADMIN'));
adminRouter.use('/tasks', adminTasksRouter);
adminRouter.use('/announcements', adminAnnouncementsRouter);
adminRouter.use('/users', adminUsersRouter);
adminRouter.use('/office', adminOfficeRouter);
adminRouter.use('/leaves', adminLeavesRouter);

adminRouter.get('/overview', asyncHandler(controller.overview));
adminRouter.get('/attendance/live', asyncHandler(controller.liveAttendance));
adminRouter.post(
  '/attendance/manual',
  validate({ body: manualAttendanceBody }),
  asyncHandler(controller.manualAttendance),
);
adminRouter.get('/reports', validate({ query: dateQuery }), asyncHandler(controller.reports));
