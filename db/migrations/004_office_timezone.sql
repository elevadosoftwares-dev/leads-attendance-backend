-- The company timezone moves from the APP_TIMEZONE environment variable into the office, so the super admin can
-- change it. It decides work dates, late clock-ins, the job schedules and how the app shows times. Existing offices
-- keep the previous default.
ALTER TABLE dbo.Offices ADD
    Timezone NVARCHAR(64) NOT NULL CONSTRAINT DF_Offices_Timezone DEFAULT N'Asia/Singapore';
GO
