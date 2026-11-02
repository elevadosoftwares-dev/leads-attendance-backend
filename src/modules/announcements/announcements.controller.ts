import type { Request, Response } from 'express';
import { currentUser } from '../../middleware/auth';
import { parsedParams, parsedQuery } from '../../middleware/validate';
import { ok } from '../../utils/apiResponse';
import type { ListAnnouncementsQuery } from './announcements.schemas';
import * as announcementsService from './announcements.service';

type IdParams = { id: number };

export async function list(req: Request, res: Response) {
  const { category, page, pageSize } = parsedQuery<ListAnnouncementsQuery>(req);
  ok(res, await announcementsService.list(category, page, pageSize));
}

export async function get(req: Request, res: Response) {
  ok(res, await announcementsService.get(parsedParams<IdParams>(req).id));
}

export async function create(req: Request, res: Response) {
  ok(res, await announcementsService.create(currentUser(req).id, req.body), 201);
}

export async function update(req: Request, res: Response) {
  ok(res, await announcementsService.update(parsedParams<IdParams>(req).id, req.body));
}

export async function remove(req: Request, res: Response) {
  await announcementsService.remove(parsedParams<IdParams>(req).id);
  ok(res, {});
}
