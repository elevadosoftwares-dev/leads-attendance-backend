import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates and coerces `req.body`, `req.query` and `req.params`, replacing them with the parsed values.
 * Failures become a `VALIDATION_ERROR` via the central error handler.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Reusable `:id` param schema. */
export const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Reusable pagination query fields. */
export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const workDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
    {
      message: 'must be a valid date',
    },
  );

export const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm (24-hour)');

/** Typed accessor for a query that `validate` has already parsed. */
export function parsedQuery<T>(req: Request): T {
  return req.query as unknown as T;
}

/** Typed accessor for params that `validate` has already parsed. */
export function parsedParams<T>(req: Request): T {
  return req.params as unknown as T;
}
