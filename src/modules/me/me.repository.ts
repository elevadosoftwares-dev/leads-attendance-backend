import { createRequest, sql } from '../../db/pool';

/** Registers an FCM token for the user; a token that moves to another account is reassigned. */
export async function upsertDeviceToken(userId: number, fcmToken: string, platform: string): Promise<void> {
  const request = await createRequest();
  await request
    .input('userId', sql.Int, userId)
    .input('token', sql.NVarChar(512), fcmToken)
    .input('platform', sql.NVarChar(10), platform)
    .query(
      `MERGE dbo.DeviceTokens WITH (HOLDLOCK) AS target
       USING (SELECT @token AS FcmToken) AS source ON target.FcmToken = source.FcmToken
       WHEN MATCHED THEN
         UPDATE SET UserId = @userId, Platform = @platform, UpdatedUtc = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN
         INSERT (UserId, FcmToken, Platform) VALUES (@userId, @token, @platform);`,
    );
}
