import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as attendanceController from '../attendance/attendance.controller';
import { changePasswordBody } from '../auth/auth.schemas';
import { myLeavesRouter } from '../leaves/leaves.routes';
import * as controller from './me.controller';
import { deviceTokenBody } from './me.schemas';

export const meRouter = Router();

meRouter.use(authenticate);
meRouter.get('/', asyncHandler(controller.getMe));
meRouter.get('/today', requireRole('EMPLOYEE'), asyncHandler(attendanceController.getToday));
meRouter.use('/leaves', myLeavesRouter);
meRouter.post(
  '/device-token',
  validate({ body: deviceTokenBody }),
  asyncHandler(controller.registerDeviceToken),
);
meRouter.post(
  '/change-password',
  validate({ body: changePasswordBody }),
  asyncHandler(controller.changePassword),
);
