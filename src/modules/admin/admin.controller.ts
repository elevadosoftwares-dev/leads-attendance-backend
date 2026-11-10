import type { Request, Response } from 'express';
import { currentUser } from '../../middleware/auth';
import { parsedQuery } from '../../middleware/validate';
import { ok } from '../../utils/apiResponse';
import * as adminService from './admin.service';

export async function overview(_req: Request, res: Response) {
  ok(res, await adminService.getOverview());
}

export async function liveAttendance(_req: Request, res: Response) {
  ok(res, await adminService.getLiveAttendance());
}

export async function manualAttendance(req: Request, res: Response) {
  ok(res, await adminService.addManualAttendance(currentUser(req).id, req.body), 201);
}

export async function reports(req: Request, res: Response) {
  ok(res, await adminService.listReports(parsedQuery<{ date?: string }>(req).date));
}
