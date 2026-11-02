import type { Request, Response } from 'express';
import { currentUser } from '../../middleware/auth';
import { parsedQuery } from '../../middleware/validate';
import { ok } from '../../utils/apiResponse';
import * as attendanceService from './attendance.service';

export async function getToday(req: Request, res: Response) {
  ok(res, await attendanceService.getToday(currentUser(req).id));
}

export async function clockIn(req: Request, res: Response) {
  ok(res, await attendanceService.clockIn(currentUser(req).id, req.body), 201);
}

export async function getCurrent(req: Request, res: Response) {
  ok(res, await attendanceService.getCurrentShift(currentUser(req).id));
}

export async function clockOut(req: Request, res: Response) {
  ok(res, await attendanceService.clockOut(currentUser(req).id, req.body));
}

export async function getHistory(req: Request, res: Response) {
  const { month } = parsedQuery<{ month?: string }>(req);
  ok(res, await attendanceService.getHistory(currentUser(req).id, month));
}
