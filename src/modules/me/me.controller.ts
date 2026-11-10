import type { Request, Response } from 'express';
import { currentUser } from '../../middleware/auth';
import { ok } from '../../utils/apiResponse';
import * as authService from '../auth/auth.service';
import * as meService from './me.service';

export async function getMe(req: Request, res: Response) {
  ok(res, await meService.getProfile(currentUser(req).id));
}

export async function registerDeviceToken(req: Request, res: Response) {
  const { fcmToken, platform, silent } = req.body;
  await meService.registerDeviceToken(currentUser(req).id, fcmToken, platform, silent);
  ok(res, {});
}

export async function changePassword(req: Request, res: Response) {
  await authService.changePassword(currentUser(req).id, req.body.currentPassword, req.body.newPassword);
  ok(res, {});
}
