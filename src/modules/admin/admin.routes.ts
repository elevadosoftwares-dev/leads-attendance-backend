import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { adminTasksRouter } from '../tasks/tasks.routes';

/** Everything under /admin requires an ADMIN access token. */
export const adminRouter = Router();

adminRouter.use(authenticate, requireRole('ADMIN'));
adminRouter.use('/tasks', adminTasksRouter);
