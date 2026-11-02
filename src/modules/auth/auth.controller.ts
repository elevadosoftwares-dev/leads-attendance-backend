import type { Request, Response } from 'express';
import { currentUser } from '../../middleware/auth';
import { ok } from '../../utils/apiResponse';
import * as authService from './auth.service';

export async function login(req: Request, res: Response) {
  ok(res, await authService.login(req.body.email, req.body.password));
}

export async function refresh(req: Request, res: Response) {
  ok(res, await authService.refresh(req.body.refreshToken));
}

export async function logout(req: Request, res: Response) {
  await authService.logout(currentUser(req).id, req.body.refreshToken);
  ok(res, {});
}

export async function forgotPassword(req: Request, res: Response) {
  await authService.forgotPassword(req.body.email);
  ok(res, {});
}

export async function resetPassword(req: Request, res: Response) {
  await authService.resetPassword(req.body.token, req.body.newPassword);
  ok(res, {});
}
