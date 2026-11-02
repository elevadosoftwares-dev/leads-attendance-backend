import { bindIntList, createRequest, sql } from '../../db/pool';
import type { Role } from '../auth/auth.types';

export async function listTokensForUsers(userIds: number[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const request = await createRequest();
  const list = bindIntList(request, 'u', userIds);
  const result = await request.query<{ FcmToken: string }>(
    `SELECT d.FcmToken FROM dbo.DeviceTokens d JOIN dbo.Users u ON u.UserId = d.UserId
      WHERE u.IsActive = 1 AND d.UserId IN (${list})`,
  );
  return result.recordset.map((r) => r.FcmToken);
}

export async function listTokensForActiveUsers(role?: Role): Promise<string[]> {
  const request = await createRequest();
  const result = await request.input('role', sql.NVarChar(20), role ?? null).query<{ FcmToken: string }>(
    `SELECT d.FcmToken FROM dbo.DeviceTokens d JOIN dbo.Users u ON u.UserId = d.UserId
      WHERE u.IsActive = 1 AND (@role IS NULL OR u.Role = @role)`,
  );
  return result.recordset.map((r) => r.FcmToken);
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
