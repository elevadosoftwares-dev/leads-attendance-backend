-- SUPER_ADMIN: the one account that owns the office settings (location, geofence, working time) and manages
-- the admins. It is created by `npm run seed` only, never through the API.
ALTER TABLE dbo.Users DROP CONSTRAINT CK_Users_Role;
GO

ALTER TABLE dbo.Users ADD CONSTRAINT CK_Users_Role CHECK (Role IN (N'EMPLOYEE', N'ADMIN', N'SUPER_ADMIN'));
GO

-- Working-time settings move from environment variables into the office, so the super admin can change them.
ALTER TABLE dbo.Offices ADD
    DefaultShiftStart TIME(0) NOT NULL CONSTRAINT DF_Offices_DefaultShiftStart DEFAULT '09:00',
    LateGraceMinutes  INT     NOT NULL CONSTRAINT DF_Offices_LateGraceMinutes DEFAULT 10
        CONSTRAINT CK_Offices_LateGraceMinutes CHECK (LateGraceMinutes BETWEEN 0 AND 240);
GO
