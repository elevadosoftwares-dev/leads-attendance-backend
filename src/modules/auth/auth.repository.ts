import { createRequest, sql, type Queryable } from '../../db/pool';

export interface RefreshTokenRow {
  TokenId: number;
  UserId: number;
  ExpiresUtc: Date;
  RevokedUtc: Date | null;
}

export async function insertRefreshToken(
  userId: number,
  tokenHash: string,
  expiresUtc: Date,
  db?: Queryable,
): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('userId', sql.Int, userId)
    .input('hash', sql.Char(64), tokenHash)
    .input('expires', sql.DateTime2(0), expiresUtc)
    .query('INSERT INTO dbo.RefreshTokens (UserId, TokenHash, ExpiresUtc) VALUES (@userId, @hash, @expires)');
}

export async function findRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
  const request = await createRequest();
  const result = await request
    .input('hash', sql.Char(64), tokenHash)
    .query<RefreshTokenRow>(
      'SELECT TokenId, UserId, ExpiresUtc, RevokedUtc FROM dbo.RefreshTokens WHERE TokenHash = @hash',
    );
  return result.recordset[0] ?? null;
}

/** Revokes one token; returns false if it was already revoked (lost a race with another refresh). */
export async function revokeRefreshToken(tokenId: number, db?: Queryable): Promise<boolean> {
  const request = await createRequest(db);
  const result = await request
    .input('tokenId', sql.Int, tokenId)
    .query(
      'UPDATE dbo.RefreshTokens SET RevokedUtc = SYSUTCDATETIME() WHERE TokenId = @tokenId AND RevokedUtc IS NULL',
    );
  return result.rowsAffected[0] === 1;
}

export async function revokeRefreshTokenByHash(userId: number, tokenHash: string): Promise<void> {
  const request = await createRequest();
  await request
    .input('userId', sql.Int, userId)
    .input('hash', sql.Char(64), tokenHash)
    .query(
      `UPDATE dbo.RefreshTokens SET RevokedUtc = SYSUTCDATETIME()
       WHERE TokenHash = @hash AND UserId = @userId AND RevokedUtc IS NULL`,
    );
}

export async function revokeAllRefreshTokens(userId: number, db?: Queryable): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('userId', sql.Int, userId)
    .query(
      'UPDATE dbo.RefreshTokens SET RevokedUtc = SYSUTCDATETIME() WHERE UserId = @userId AND RevokedUtc IS NULL',
    );
}

export interface PasswordResetRow {
  ResetId: number;
  UserId: number;
}

export async function insertPasswordReset(
  userId: number,
  tokenHash: string,
  expiresUtc: Date,
): Promise<void> {
  const request = await createRequest();
  await request
    .input('userId', sql.Int, userId)
    .input('hash', sql.Char(64), tokenHash)
    .input('expires', sql.DateTime2(0), expiresUtc)
    .query(
      'INSERT INTO dbo.PasswordResets (UserId, TokenHash, ExpiresUtc) VALUES (@userId, @hash, @expires)',
    );
}

/** Finds an unused, unexpired reset token, locking it for the rest of the transaction. */
export async function findValidPasswordReset(
  tokenHash: string,
  now: Date,
  db: Queryable,
): Promise<PasswordResetRow | null> {
  const request = await createRequest(db);
  const result = await request
    .input('hash', sql.Char(64), tokenHash)
    .input('now', sql.DateTime2(0), now)
    .query<PasswordResetRow>(
      `SELECT ResetId, UserId FROM dbo.PasswordResets WITH (UPDLOCK, ROWLOCK)
       WHERE TokenHash = @hash AND UsedUtc IS NULL AND ExpiresUtc > @now`,
    );
  return result.recordset[0] ?? null;
}

/** Marks every outstanding reset token for the user as used (the one just consumed included). */
export async function consumePasswordResets(userId: number, db: Queryable): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('userId', sql.Int, userId)
    .query(
      'UPDATE dbo.PasswordResets SET UsedUtc = SYSUTCDATETIME() WHERE UserId = @userId AND UsedUtc IS NULL',
    );
}
