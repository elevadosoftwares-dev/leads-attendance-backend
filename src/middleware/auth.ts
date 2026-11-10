import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError';
import { verifyAccessToken } from '../modules/auth/token.service';
import type { AuthUser, Role } from '../modules/auth/auth.types';
import { findAuthState } from '../modules/users/users.repository';

/** A removed (INACTIVE) account presenting a token that was issued before the removal. */
export const accountRemoved = () =>
  new AppError(401, 'ACCOUNT_INACTIVE', 'Your account has been deactivated');

/**
 * Verifies a token and re-reads the account, so deactivating a user or changing their role takes effect
 * immediately rather than when the access token expires.
 */
export async function resolveAccessToken(token: string): Promise<AuthUser> {
  const claims = verifyAccessToken(token);
  const state = await findAuthState(claims.id);
  if (!state) throw AppError.unauthorized('Account no longer exists');
  // 401 (not 403) so clients end the session; the code lets them say why.
  if (!state.IsActive) throw accountRemoved();
  return { id: claims.id, role: state.Role };
}

/** Verifies the `Authorization: Bearer <accessToken>` header and sets `req.user`. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(AppError.unauthorized('Missing access token'));
  }
  resolveAccessToken(header.slice('Bearer '.length).trim()).then(
    (user) => {
      req.user = user;
      next();
    },
    (err: unknown) => next(err),
  );
}

/**
 * Allows the request only when the authenticated user has one of the given roles.
 * SUPER_ADMIN satisfies an ADMIN requirement: the super admin can do everything an admin can.
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(AppError.unauthorized());
    const role = req.user.role;
    const allowed = roles.includes(role) || (role === 'SUPER_ADMIN' && roles.includes('ADMIN'));
    if (!allowed) return next(AppError.forbidden());
    next();
  };
}

/** The authenticated user; only call from handlers mounted behind `authenticate`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}
