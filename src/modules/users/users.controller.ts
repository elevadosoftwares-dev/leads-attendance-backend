import type { Request, Response } from 'express';
import { currentUser } from '../../middleware/auth';
import { parsedParams, parsedQuery } from '../../middleware/validate';
import { ok } from '../../utils/apiResponse';
import type { Role } from '../auth/auth.types';
import type { UserStatus } from './users.repository';
import * as usersService from './users.service';

type IdParams = { id: number };

export async function list(req: Request, res: Response) {
  const { status, role } = parsedQuery<{ status: UserStatus; role?: Role }>(req);
  ok(res, await usersService.listUsers(status, role));
}

export async function create(req: Request, res: Response) {
  ok(res, await usersService.createUser(currentUser(req), req.body), 201);
}

export async function update(req: Request, res: Response) {
  ok(res, await usersService.updateUser(currentUser(req), parsedParams<IdParams>(req).id, req.body));
}

export async function approve(req: Request, res: Response) {
  ok(res, await usersService.approveUser(currentUser(req), parsedParams<IdParams>(req).id, req.body));
}

export async function reject(req: Request, res: Response) {
  await usersService.rejectUser(parsedParams<IdParams>(req).id);
  ok(res, {});
}

export async function deactivate(req: Request, res: Response) {
  ok(res, await usersService.deactivateUser(currentUser(req), parsedParams<IdParams>(req).id));
}

export async function reactivate(req: Request, res: Response) {
  ok(res, await usersService.reactivateUser(currentUser(req), parsedParams<IdParams>(req).id));
}
