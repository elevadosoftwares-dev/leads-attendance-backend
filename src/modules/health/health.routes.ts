import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { pingDatabase } from './health.repository';
import { ok, errorBody } from '../../utils/apiResponse';
import { isoUtc } from '../../utils/time';

export const healthRouter = Router();

healthRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    try {
      await pingDatabase();
      ok(res, { status: 'ok', database: 'up', timeUtc: isoUtc(new Date()) });
    } catch (err) {
      req.log.warn({ err }, 'Health check: database unreachable');
      res.status(503).json(errorBody('SERVICE_UNAVAILABLE', 'Database is unreachable', { database: 'down' }));
    }
  }),
);
