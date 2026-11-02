import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env, isTest } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { adminRouter } from './modules/admin/admin.routes';
import { attendanceRouter } from './modules/attendance/attendance.routes';
import { createAuthRouter } from './modules/auth/auth.routes';
import { healthRouter } from './modules/health/health.routes';
import { meRouter } from './modules/me/me.routes';
import { filesRouter, tasksRouter } from './modules/tasks/tasks.routes';
import { logger } from './utils/logger';

function apiRouter(): Router {
  const router = Router();
  router.use('/health', healthRouter);
  router.use('/auth', createAuthRouter());
  router.use('/me', meRouter);
  router.use('/attendance', attendanceRouter);
  router.use('/tasks', tasksRouter);
  router.use('/files', filesRouter);
  router.use('/admin', adminRouter);
  return router;
}

/** Builds the Express app without listening, so tests can drive it with supertest. */
export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(pinoHttp({ logger, autoLogging: !isTest }));
  app.use(helmet());
  app.use(
    cors({
      // Native mobile clients send no Origin header; browsers must be on the allow-list.
      origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', apiRouter());

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
