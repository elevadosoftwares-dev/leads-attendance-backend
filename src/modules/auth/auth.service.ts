import bcrypt from 'bcrypt';
import { env } from '../../config/env';
import { withTransaction } from '../../db/pool';
import { mailService } from '../../services/mail.service';
import { AppError } from '../../utils/AppError';
import { accountRemoved } from '../../middleware/auth';
import { logger } from '../../utils/logger';
import { fromTimeColumn, isUniqueViolation } from '../../db/pool';
import { pushService } from '../../services/push.service';
import { realtime } from '../../services/realtime.service';
import * as officesRepo from '../offices/offices.repository';
import { toUserDto, type UserDto } from '../users/users.mapper';
import * as usersRepo from '../users/users.repository';
import * as authRepo from './auth.repository';
import { ADMIN_ROLES } from './auth.types';
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
  if (!user || !passwordOk) throw invalidCredentials();
  // Only reveal the account state to someone who knows the password.
  if (user.Status === 'PENDING') {
    throw new AppError(403, 'ACCOUNT_PENDING', 'Your account is waiting for admin approval');
  }
  if (!user.IsActive) throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your account has been deactivated');

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

  // Removing a user revokes their refresh tokens; report that rather than token reuse.
  const user = await usersRepo.findUserById(row.UserId);
  if (user && !user.IsActive && user.Status === 'INACTIVE') {
    await authRepo.revokeAllRefreshTokens(row.UserId);
    throw accountRemoved();
  }

  if (row.RevokedUtc) throw await reuseDetected();
  if (row.ExpiresUtc.getTime() <= Date.now()) {
    throw new AppError(401, 'TOKEN_EXPIRED', 'Refresh token has expired');
  }

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

/** The office new users join; until the super admin's seed has run there is none. */
export async function requireDefaultOffice(): Promise<officesRepo.OfficeRow> {
  const office = await officesRepo.findDefaultOffice();
  if (!office) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'No office is configured yet');
  return office;
}

export const emailTaken = () =>
  new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists', {
    fields: [{ field: 'email', message: 'is already registered' }],
  });

export interface PendingUserDto {
  id: number;
  name: string;
  email: string;
  status: 'PENDING';
}

/**
 * Self sign-up. The account is created as a PENDING employee and cannot log in until an admin approves it;
 * admins are only ever created by the super admin. The shift start and end are the office defaults.
 */
export async function signup(name: string, email: string, password: string): Promise<PendingUserDto> {
  const office = await requireDefaultOffice();

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  let id: number;
  try {
    id = await usersRepo.insertUser({
      name,
      email,
      passwordHash,
      role: 'EMPLOYEE',
      officeId: office.OfficeId,
      shiftStart: fromTimeColumn(office.DefaultShiftStart),
      shiftEnd: fromTimeColumn(office.DefaultShiftEnd),
      status: 'PENDING',
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken();
    throw err;
  }

  const dto: PendingUserDto = { id, name, email, status: 'PENDING' };
  realtime.userPending(dto);
  void pushService.notifyAllActive(
    {
      title: 'New sign-up awaiting approval',
      body: `${name} (${email})`,
      data: { type: 'USER_PENDING', userId: String(id) },
    },
    ADMIN_ROLES,
  );
  return dto;
}

/** Changes the signed-in user's password and signs out every other device. */
export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await usersRepo.findUserById(userId);
  if (!user || !user.IsActive) throw AppError.unauthorized('Account is not active');
  if (!(await bcrypt.compare(currentPassword, user.PasswordHash))) {
    throw AppError.validation('Current password is incorrect', {
      fields: [{ field: 'currentPassword', message: 'is incorrect' }],
    });
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await withTransaction(async (tx) => {
    await usersRepo.updatePasswordHash(userId, passwordHash, tx);
    await authRepo.revokeAllRefreshTokens(userId, tx);
  });
}
