import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { isProduction } from '../config/env';
import { AppError } from '../utils/AppError';
import { errorBody } from '../utils/apiResponse';
import { logger } from '../utils/logger';

function zodDetails(err: ZodError) {
  return {
    fields: err.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

// Express recognises error handlers by their four-argument signature.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    req.log?.error({ err }, 'Error after response was sent');
    res.end();
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json(errorBody(err.code, err.message, err.details));
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json(errorBody('VALIDATION_ERROR', 'Request validation failed', zodDetails(err)));
    return;
  }

  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : `Upload rejected: ${err.message.toLowerCase()}`;
    res
      .status(400)
      .json(errorBody('VALIDATION_ERROR', message, { fields: [{ field: err.field ?? 'file', message }] }));
    return;
  }

  // body-parser errors carry an HTTP status and a `type`.
  const bodyErr = err as { type?: string; status?: number };
  if (bodyErr.type === 'entity.parse.failed') {
    res.status(400).json(errorBody('VALIDATION_ERROR', 'Malformed JSON body'));
    return;
  }
  if (bodyErr.type === 'entity.too.large') {
    res.status(413).json(errorBody('VALIDATION_ERROR', 'Request body is too large'));
    return;
  }

  (req.log ?? logger).error({ err }, 'Unhandled error');
  const details = isProduction ? {} : { message: err instanceof Error ? err.message : String(err) };
  res.status(500).json(errorBody('INTERNAL_ERROR', 'An unexpected error occurred', details));
}
