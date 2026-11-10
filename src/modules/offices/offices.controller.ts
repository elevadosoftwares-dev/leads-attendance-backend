import type { Request, Response } from 'express';
import { ok } from '../../utils/apiResponse';
import * as officesService from './offices.service';

export async function get(_req: Request, res: Response) {
  ok(res, await officesService.getOfficeSettings());
}

export async function update(req: Request, res: Response) {
  ok(res, await officesService.updateOfficeSettings(req.body));
}
