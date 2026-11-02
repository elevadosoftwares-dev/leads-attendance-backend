import bcrypt from 'bcrypt';
import { env } from '../../config/env';
import { withTransaction } from '../../db/pool';
import { mailService } from '../../services/mail.service';
import { AppError } from '../../utils/AppError';
import { logger } from '../../utils/logger';
import { toUserDto, type UserDto } from '../users/users.mapper';
import * as usersRepo from '../users/users.repository';
import * as authRepo from './auth.repository';
import { generateOpaqueToken, hashToken, refreshTokenExpiry, signAccessToken } from './token.service';

export const BCRYPT_COST = 12;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

// Compared against when the email is unknown, so both paths cost one bcrypt verification.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash('timing-equaliser-not-a-password', BCRYPT_COST));

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

async function issueTokens(user: { UserId: number; Role: usersRepo.UserRow['Role'] }): Promise<TokenPair> {
  const refreshToken = generateOpaqueToken();
  await authRepo.insertRefreshToken(user.UserId, hashToken(refreshToken), refreshTokenExpiry());
  return { accessToken: signAccessToken({ id: user.UserId, role: user.Role }), refreshToken };
}

export async function login(email: string, password: string): Promise<TokenPair & { user: UserDto }> {
  const user = await usersRepo.findUserByEmail(email);
  const passwordOk = await bcrypt.compare(password, user?.PasswordHash ?? (await getDummyHash()));
  if (!user || !passwordOk || !user.IsActive) throw invalidCredentials();

  const tokens = await issueTokens(user);
  return { ...tokens, user: toUserDto(user) };
}

/**
 * Rotates a refresh token. Presenting a token that was already rotated or revoked is treated as theft:
 * every refresh token the user holds is revoked.
 */
export async function refresh(refreshToken: string): Promise<TokenPair> {
  const row = await authRepo.findRefreshToken(hashToken(refreshToken));
  if (!row) throw AppError.unauthorized('Invalid refresh token');

  const reuseDetected = async () => {
    await authRepo.revokeAllRefreshTokens(row.UserId);
    logger.warn({ userId: row.UserId }, 'Refresh token reuse detected; all sessions revoked');
    return AppError.unauthorized('Refresh token has been revoked');
  };

  if (row.RevokedUtc) throw await reuseDetected();
  if (row.ExpiresUtc.getTime() <= Date.now()) {
    throw new AppError(401, 'TOKEN_EXPIRED', 'Refresh token has expired');
  }

  const user = await usersRepo.findUserById(row.UserId);
  if (!user || !user.IsActive) {
    await authRepo.revokeAllRefreshTokens(row.UserId);
    throw AppError.unauthorized('Account is not active');
  }

  const next = generateOpaqueToken();
  const rotated = await withTransaction(async (tx) => {
    if (!(await authRepo.revokeRefreshToken(row.TokenId, tx))) return false;
    await authRepo.insertRefreshToken(user.UserId, hashToken(next), refreshTokenExpiry(), tx);
    return true;
  });
  // Another request rotated the same token first: that is a replay.
  if (!rotated) throw await reuseDetected();

  return { accessToken: signAccessToken({ id: user.UserId, role: user.Role }), refreshToken: next };
}

export async function logout(userId: number, refreshToken: string): Promise<void> {
  await authRepo.revokeRefreshTokenByHash(userId, hashToken(refreshToken));
}

function resetLink(token: string): string {
  const base = env.PASSWORD_RESET_URL ?? `${env.PUBLIC_BASE_URL}/reset-password`;
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Always succeeds from the caller's point of view, so it never reveals whether the email exists. */
export async function forgotPassword(email: string): Promise<void> {
  const user = await usersRepo.findUserByEmail(email);
  if (!user || !user.IsActive) return;

  const token = generateOpaqueToken(32);
  await authRepo.insertPasswordReset(
    user.UserId,
    hashToken(token),
    new Date(Date.now() + RESET_TOKEN_TTL_MS),
  );
  mailService.sendPasswordReset(user.Email, user.Name, resetLink(token)).catch((err: unknown) => {
    logger.error({ err, userId: user.UserId }, 'Failed to send password reset email');
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const ok = await withTransaction(async (tx) => {
    const reset = await authRepo.findValidPasswordReset(hashToken(token), new Date(), tx);
    if (!reset) return false;
    await usersRepo.updatePasswordHash(reset.UserId, passwordHash, tx);
    await authRepo.consumePasswordResets(reset.UserId, tx);
    // Sign out every device after a password change.
    await authRepo.revokeAllRefreshTokens(reset.UserId, tx);
    return true;
  });
  if (!ok) {
    throw AppError.validation('Reset token is invalid or has expired', {
      fields: [{ field: 'token', message: 'invalid or expired' }],
    });
  }
}
