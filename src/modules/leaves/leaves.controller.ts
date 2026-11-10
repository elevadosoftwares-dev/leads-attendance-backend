import type { Request, Response } from 'express';
import { currentUser } from '../../middleware/auth';
import { parsedParams, parsedQuery } from '../../middleware/validate';
import { ok } from '../../utils/apiResponse';
import type { ListLeavesQuery } from './leaves.schemas';
import * as service from './leaves.service';

const leaveId = (req: Request) => parsedParams<{ id: number }>(req).id;

// ---- admin (/admin/leaves)

export async function list(req: Request, res: Response) {
  ok(res, await service.listLeaves(parsedQuery<ListLeavesQuery>(req)));
}

export async function create(req: Request, res: Response) {
  ok(res, await service.recordLeave(currentUser(req).id, req.body), 201);
}

export async function approve(req: Request, res: Response) {
  ok(res, await service.approveLeave(currentUser(req).id, leaveId(req), req.body.note));
}

export async function reject(req: Request, res: Response) {
  ok(res, await service.rejectLeave(currentUser(req).id, leaveId(req), req.body.note));
}

export async function cancel(req: Request, res: Response) {
  ok(res, await service.cancelLeave(currentUser(req).id, leaveId(req), req.body.note));
}

// ---- employee (/me/leaves)

export async function listMine(req: Request, res: Response) {
  ok(res, await service.listMyLeaves(currentUser(req).id));
}

export async function request(req: Request, res: Response) {
  ok(res, await service.requestLeave(currentUser(req).id, req.body), 201);
}

export async function withdraw(req: Request, res: Response) {
  ok(res, await service.withdrawLeave(currentUser(req).id, leaveId(req)));
}
