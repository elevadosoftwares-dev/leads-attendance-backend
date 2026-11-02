import { Router, type Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { errorBody } from '../../utils/apiResponse';
import * as controller from './auth.controller';
import { forgotPasswordBody, loginBody, refreshBody, resetPasswordBody } from './auth.schemas';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** 5 attempts per 15 minutes per IP + email. */
function perIpAndEmailLimiter(message: string) {
  return rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      return `${ipKeyGenerator(req.ip ?? '')}|${email}`;
    },
    handler: (_req, res) => {
      res.status(429).json(errorBody('RATE_LIMITED', message));
    },
  });
}

/** Built per app instance so each app (and each test) gets its own rate-limit store. */
export function createAuthRouter(): Router {
  const router = Router();

  router.post(
    '/login',
    perIpAndEmailLimiter('Too many login attempts. Try again in 15 minutes.'),
    validate({ body: loginBody }),
    asyncHandler(controller.login),
  );
  router.post('/refresh', validate({ body: refreshBody }), asyncHandler(controller.refresh));
  router.post('/logout', authenticate, validate({ body: refreshBody }), asyncHandler(controller.logout));
  router.post(
    '/forgot-password',
    perIpAndEmailLimiter('Too many password reset requests. Try again in 15 minutes.'),
    validate({ body: forgotPasswordBody }),
    asyncHandler(controller.forgotPassword),
  );
  router.post(
    '/reset-password',
    validate({ body: resetPasswordBody }),
    asyncHandler(controller.resetPassword),
  );

  return router;
}
