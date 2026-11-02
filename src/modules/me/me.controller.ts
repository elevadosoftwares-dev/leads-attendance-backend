import type { Request, Response } from 'express';
import { currentUser } from '../../middleware/auth';
import { ok } from '../../utils/apiResponse';
import * as meService from './me.service';

export async function getMe(req: Request, res: Response) {
  ok(res, await meService.getProfile(currentUser(req).id));
}

export async function registerDeviceToken(req: Request, res: Response) {
  await meService.registerDeviceToken(currentUser(req).id, req.body.fcmToken, req.body.platform);
  ok(res, {});
}
