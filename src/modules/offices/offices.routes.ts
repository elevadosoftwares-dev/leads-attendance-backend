import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './offices.controller';
import { updateOfficeBody } from './offices.schemas';

/** Mounted at /admin/office: any admin may read the settings, only the super admin may change them. */
export const adminOfficeRouter = Router();

adminOfficeRouter.get('/', asyncHandler(controller.get));
adminOfficeRouter.patch(
  '/',
  requireRole('SUPER_ADMIN'),
  validate({ body: updateOfficeBody }),
  asyncHandler(controller.update),
);
