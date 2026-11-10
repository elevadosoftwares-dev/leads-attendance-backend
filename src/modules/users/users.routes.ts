import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idParam, validate } from '../../middleware/validate';
import * as controller from './users.controller';
import { approveUserBody, createUserBody, listUsersQuery, updateUserBody } from './users.schemas';

/** User management, mounted at /admin/users behind the admin router's ADMIN check. */
export const adminUsersRouter = Router();

adminUsersRouter.get('/', validate({ query: listUsersQuery }), asyncHandler(controller.list));
adminUsersRouter.post('/', validate({ body: createUserBody }), asyncHandler(controller.create));
adminUsersRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateUserBody }),
  asyncHandler(controller.update),
);
adminUsersRouter.delete('/:id', validate({ params: idParam }), asyncHandler(controller.deactivate));
adminUsersRouter.post(
  '/:id/approve',
  validate({ params: idParam, body: approveUserBody }),
  asyncHandler(controller.approve),
);
adminUsersRouter.post('/:id/reject', validate({ params: idParam }), asyncHandler(controller.reject));
adminUsersRouter.post('/:id/reactivate', validate({ params: idParam }), asyncHandler(controller.reactivate));
