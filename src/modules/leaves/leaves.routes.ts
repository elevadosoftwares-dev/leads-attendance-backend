import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireRole } from '../../middleware/auth';
import { idParam, validate } from '../../middleware/validate';
import * as controller from './leaves.controller';
import { createLeaveBody, listLeavesQuery, requestLeaveBody, reviewLeaveBody } from './leaves.schemas';

/** Mounted at /admin/leaves (behind the admin guard). */
export const adminLeavesRouter = Router();

adminLeavesRouter.get('/', validate({ query: listLeavesQuery }), asyncHandler(controller.list));
adminLeavesRouter.post('/', validate({ body: createLeaveBody }), asyncHandler(controller.create));
for (const [action, handler] of [
  ['approve', controller.approve],
  ['reject', controller.reject],
  ['cancel', controller.cancel],
] as const) {
  adminLeavesRouter.post(
    `/:id/${action}`,
    validate({ params: idParam, body: reviewLeaveBody }),
    asyncHandler(handler),
  );
}

/** Mounted at /me/leaves (behind `authenticate`): an employee's own leave. */
export const myLeavesRouter = Router();

myLeavesRouter.use(requireRole('EMPLOYEE'));
myLeavesRouter.get('/', asyncHandler(controller.listMine));
myLeavesRouter.post('/', validate({ body: requestLeaveBody }), asyncHandler(controller.request));
myLeavesRouter.post('/:id/withdraw', validate({ params: idParam }), asyncHandler(controller.withdraw));
