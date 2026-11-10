-- Per-device "silent notifications" setting from the app: silent devices get pushes on the app's silent Android
-- channel and without an iOS sound.
ALTER TABLE dbo.DeviceTokens ADD
    Silent BIT NOT NULL CONSTRAINT DF_DeviceTokens_Silent DEFAULT 0;
GO
