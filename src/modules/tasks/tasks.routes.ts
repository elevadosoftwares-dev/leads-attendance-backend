import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticate, requireRole } from '../../middleware/auth';
import { singleFileUpload } from '../../middleware/upload';
import { idParam, validate } from '../../middleware/validate';
import * as controller from './tasks.controller';
import {
  adminListQuery,
  createTaskBody,
  listTasksQuery,
  updateStatusBody,
  updateTaskBody,
} from './tasks.schemas';

/** Employee task routes, mounted at /tasks. */
export const tasksRouter = Router();

tasksRouter.use(authenticate);
tasksRouter.get(
  '/',
  requireRole('EMPLOYEE'),
  validate({ query: listTasksQuery }),
  asyncHandler(controller.list),
);
tasksRouter.get(
  '/:id',
  requireRole('EMPLOYEE', 'ADMIN'),
  validate({ params: idParam }),
  asyncHandler(controller.get),
);
tasksRouter.patch(
  '/:id/status',
  requireRole('EMPLOYEE'),
  validate({ params: idParam, body: updateStatusBody }),
  asyncHandler(controller.updateStatus),
);
tasksRouter.post(
  '/:id/attachments',
  requireRole('EMPLOYEE'),
  validate({ params: idParam }),
  asyncHandler(controller.ensureOwnTask),
  singleFileUpload,
  asyncHandler(controller.uploadAttachment),
);

/** Authenticated file download, mounted at /files. Never served as a static folder. */
export const filesRouter = Router();

filesRouter.get('/:id', authenticate, validate({ params: idParam }), asyncHandler(controller.downloadFile));

/** Admin task routes, mounted at /admin/tasks (the admin router applies requireRole('ADMIN')). */
export const adminTasksRouter = Router();

adminTasksRouter.post('/', validate({ body: createTaskBody }), asyncHandler(controller.adminCreate));
adminTasksRouter.get('/', validate({ query: adminListQuery }), asyncHandler(controller.adminList));
adminTasksRouter.get('/stats', asyncHandler(controller.adminStats));
adminTasksRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateTaskBody }),
  asyncHandler(controller.adminUpdate),
);
adminTasksRouter.delete('/:id', validate({ params: idParam }), asyncHandler(controller.adminDelete));
