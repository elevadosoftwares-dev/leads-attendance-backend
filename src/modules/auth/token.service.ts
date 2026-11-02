import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AppError } from '../../utils/AppError';
import { durationToMs } from '../../utils/format';
import { ROLES, type AuthUser, type Role } from './auth.types';

/** Signs a short-lived access token carrying only `{ sub, role }`. */
export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: String(user.id),
    expiresIn: Math.floor(durationToMs(env.JWT_ACCESS_TTL) / 1000),
    algorithm: 'HS256',
  });
}

/** Verifies an access token; throws `TOKEN_EXPIRED` or `UNAUTHORIZED`. */
export function verifyAccessToken(token: string): AuthUser {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string') throw new Error('Unexpected token payload');
    const id = Number(payload.sub);
    const role = payload.role as Role;
    if (!Number.isInteger(id) || id <= 0 || !ROLES.includes(role)) throw new Error('Malformed token');
    return { id, role };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired');
    }
    throw AppError.unauthorized('Invalid access token');
  }
}

/** A new opaque refresh/reset token: 64 random bytes, base64url-encoded. */
export function generateOpaqueToken(bytes = 64): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 hash (hex) of an opaque token; only hashes are stored.
 * Refresh tokens are keyed with JWT_REFRESH_SECRET so a leaked table alone can't be used to forge lookups.
 */
export function hashToken(token: string): string {
  return crypto.createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex');
}

export function refreshTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + durationToMs(env.JWT_REFRESH_TTL));
}
