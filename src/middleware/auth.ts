import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError';
import { verifyAccessToken } from '../modules/auth/token.service';
import type { AuthUser, Role } from '../modules/auth/auth.types';

/** Verifies the `Authorization: Bearer <accessToken>` header and sets `req.user`. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(AppError.unauthorized('Missing access token'));
  }
  try {
    req.user = verifyAccessToken(header.slice('Bearer '.length).trim());
    next();
  } catch (err) {
    next(err);
  }
}

/** Allows the request only when the authenticated user has one of the given roles. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) return next(AppError.forbidden());
    next();
  };
}

/** The authenticated user; only call from handlers mounted behind `authenticate`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}
