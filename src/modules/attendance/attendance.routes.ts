import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './attendance.controller';
import { clockInBody, clockOutBody, historyQuery } from './attendance.schemas';

export const attendanceRouter = Router();

attendanceRouter.use(authenticate, requireRole('EMPLOYEE'));
attendanceRouter.post('/clock-in', validate({ body: clockInBody }), asyncHandler(controller.clockIn));
attendanceRouter.get('/current', asyncHandler(controller.getCurrent));
attendanceRouter.post('/clock-out', validate({ body: clockOutBody }), asyncHandler(controller.clockOut));
attendanceRouter.get('/history', validate({ query: historyQuery }), asyncHandler(controller.getHistory));
