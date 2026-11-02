import type { Request, Response } from 'express';
import { errorBody } from '../utils/apiResponse';

export function notFound(req: Request, res: Response): void {
  res.status(404).json(errorBody('NOT_FOUND', `Route ${req.method} ${req.path} not found`));
}
