import type { NextFunction, Request, Response } from 'express';
import { currentUser } from '../../middleware/auth';
import { parsedParams, parsedQuery } from '../../middleware/validate';
import { AppError } from '../../utils/AppError';
import { ok } from '../../utils/apiResponse';
import type { AdminListQuery } from './tasks.schemas';
import * as tasksService from './tasks.service';

type IdParams = { id: number };

export async function list(req: Request, res: Response) {
  const { date } = parsedQuery<{ date?: string }>(req);
  ok(res, await tasksService.listForDate(currentUser(req).id, date));
}

export async function get(req: Request, res: Response) {
  ok(res, await tasksService.getTask(currentUser(req), parsedParams<IdParams>(req).id));
}

export async function updateStatus(req: Request, res: Response) {
  ok(res, await tasksService.updateStatus(currentUser(req), parsedParams<IdParams>(req).id, req.body.status));
}

/** Runs before the upload middleware so files for someone else's task are never written to disk. */
export async function ensureOwnTask(req: Request, _res: Response, next: NextFunction) {
  await tasksService.assertOwnTask(currentUser(req), parsedParams<IdParams>(req).id);
  next();
}

export async function uploadAttachment(req: Request, res: Response) {
  if (!req.file) throw AppError.validation('A file is required');
  ok(res, await tasksService.addAttachment(currentUser(req), parsedParams<IdParams>(req).id, req.file), 201);
}

export async function downloadFile(req: Request, res: Response) {
  const file = await tasksService.openAttachment(currentUser(req), parsedParams<IdParams>(req).id);
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Length', String(file.size));
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${file.fileName.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  );
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  await new Promise<void>((resolve, reject) => {
    file.stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
    file.stream.pipe(res);
  });
}

// ---------- Admin ----------

export async function adminCreate(req: Request, res: Response) {
  ok(res, await tasksService.createTask(currentUser(req).id, req.body), 201);
}

export async function adminList(req: Request, res: Response) {
  const { page, pageSize, ...filter } = parsedQuery<AdminListQuery>(req);
  ok(res, await tasksService.listForAdmin(filter, page, pageSize));
}

export async function adminStats(_req: Request, res: Response) {
  ok(res, await tasksService.stats());
}

export async function adminUpdate(req: Request, res: Response) {
  ok(res, await tasksService.updateTask(parsedParams<IdParams>(req).id, req.body));
}

export async function adminDelete(req: Request, res: Response) {
  await tasksService.deleteTask(parsedParams<IdParams>(req).id);
  ok(res, {});
}
