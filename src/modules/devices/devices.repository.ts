import { bindIntList, createRequest, sql, type Queryable } from '../../db/pool';
import type { Role } from '../auth/auth.types';

/** A registered device and whether its notifications should be silent. */
export interface DeviceToken {
  token: string;
  silent: boolean;
}

const toDevice = (r: { FcmToken: string; Silent: boolean }): DeviceToken => ({
  token: r.FcmToken,
  silent: r.Silent,
});

export async function listTokensForUsers(userIds: number[]): Promise<DeviceToken[]> {
  if (userIds.length === 0) return [];
  const request = await createRequest();
  const list = bindIntList(request, 'u', userIds);
  const result = await request.query<{ FcmToken: string; Silent: boolean }>(
    `SELECT d.FcmToken, d.Silent FROM dbo.DeviceTokens d JOIN dbo.Users u ON u.UserId = d.UserId
      WHERE u.IsActive = 1 AND d.UserId IN (${list})`,
  );
  return result.recordset.map(toDevice);
}

/** Devices of every active user, or only of active users with one of `roles`. */
export async function listTokensForActiveUsers(roles?: readonly Role[]): Promise<DeviceToken[]> {
  const request = await createRequest();
  const roleParams = (roles ?? []).map((role, i) => {
    request.input(`r${i}`, sql.NVarChar(20), role);
    return `@r${i}`;
  });
  const roleFilter = roleParams.length > 0 ? `AND u.Role IN (${roleParams.join(', ')})` : '';
  const result = await request.query<{ FcmToken: string; Silent: boolean }>(
    `SELECT d.FcmToken, d.Silent FROM dbo.DeviceTokens d JOIN dbo.Users u ON u.UserId = d.UserId
      WHERE u.IsActive = 1 ${roleFilter}`,
  );
  return result.recordset.map(toDevice);
}

export async function deleteTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  const request = await createRequest();
  const params = tokens.map((t, i) => {
    request.input(`t${i}`, sql.NVarChar(512), t);
    return `@t${i}`;
  });
  await request.query(`DELETE FROM dbo.DeviceTokens WHERE FcmToken IN (${params.join(', ')})`);
}

export async function deleteTokensForUser(userId: number, db?: Queryable): Promise<void> {
  const request = await createRequest(db);
  await request.input('userId', sql.Int, userId).query('DELETE FROM dbo.DeviceTokens WHERE UserId = @userId');
}
