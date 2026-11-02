import type { Response } from 'express';
import type { ErrorDetails } from './AppError';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ success: true, data });
}

export function errorBody(code: string, message: string, details: ErrorDetails = {}) {
  return { success: false as const, error: { code, message, details } };
}
