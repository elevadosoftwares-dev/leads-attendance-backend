-- 001_init.sql: initial LEADS Attendance schema.
-- All timestamps are UTC (DATETIME2(0)); work dates are Asia/Singapore calendar dates (DATE).

CREATE TABLE dbo.Offices (
    OfficeId      INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Offices PRIMARY KEY,
    Name          NVARCHAR(150)     NOT NULL,
    Address       NVARCHAR(300)     NOT NULL,
    Latitude      DECIMAL(9,6)      NOT NULL CONSTRAINT CK_Offices_Latitude CHECK (Latitude BETWEEN -90 AND 90),
    Longitude     DECIMAL(9,6)      NOT NULL CONSTRAINT CK_Offices_Longitude CHECK (Longitude BETWEEN -180 AND 180),
    RadiusMeters  INT               NOT NULL CONSTRAINT CK_Offices_Radius CHECK (RadiusMeters > 0),
    CreatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_Offices_CreatedUtc DEFAULT SYSUTCDATETIME(),
    UpdatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_Offices_UpdatedUtc DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE dbo.Users (
    UserId        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Users PRIMARY KEY,
    Name          NVARCHAR(150)     NOT NULL,
    Email         NVARCHAR(254)     NOT NULL,
    PasswordHash  NVARCHAR(100)     NOT NULL,
    Role          NVARCHAR(20)      NOT NULL CONSTRAINT CK_Users_Role CHECK (Role IN (N'EMPLOYEE', N'ADMIN')),
    OfficeId      INT               NOT NULL CONSTRAINT FK_Users_Offices REFERENCES dbo.Offices (OfficeId),
    ShiftStart    TIME(0)           NOT NULL CONSTRAINT DF_Users_ShiftStart DEFAULT '09:00',
    IsActive      BIT               NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT 1,
    CreatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_Users_CreatedUtc DEFAULT SYSUTCDATETIME(),
    UpdatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_Users_UpdatedUtc DEFAULT SYSUTCDATETIME(),
    -- Binary comparison, because the default collation is case-insensitive.
    CONSTRAINT CK_Users_EmailLowercase CHECK (CAST(Email AS VARBINARY(508)) = CAST(LOWER(Email) AS VARBINARY(508)))
);
CREATE UNIQUE INDEX UX_Users_Email ON dbo.Users (Email);
CREATE INDEX IX_Users_Role_IsActive ON dbo.Users (Role, IsActive) INCLUDE (Name);
GO

CREATE TABLE dbo.RefreshTokens (
    TokenId       INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_RefreshTokens PRIMARY KEY,
    UserId        INT               NOT NULL CONSTRAINT FK_RefreshTokens_Users REFERENCES dbo.Users (UserId),
    TokenHash     CHAR(64)          NOT NULL,
    ExpiresUtc    DATETIME2(0)      NOT NULL,
    RevokedUtc    DATETIME2(0)      NULL,
    CreatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_RefreshTokens_CreatedUtc DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX UX_RefreshTokens_TokenHash ON dbo.RefreshTokens (TokenHash);
CREATE INDEX IX_RefreshTokens_UserId ON dbo.RefreshTokens (UserId) WHERE RevokedUtc IS NULL;
GO

CREATE TABLE dbo.PasswordResets (
    ResetId       INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PasswordResets PRIMARY KEY,
    UserId        INT               NOT NULL CONSTRAINT FK_PasswordResets_Users REFERENCES dbo.Users (UserId),
    TokenHash     CHAR(64)          NOT NULL,
    ExpiresUtc    DATETIME2(0)      NOT NULL,
    UsedUtc       DATETIME2(0)      NULL,
    CreatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_PasswordResets_CreatedUtc DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX UX_PasswordResets_TokenHash ON dbo.PasswordResets (TokenHash);
CREATE INDEX IX_PasswordResets_UserId ON dbo.PasswordResets (UserId);
GO

CREATE TABLE dbo.DeviceTokens (
    DeviceTokenId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DeviceTokens PRIMARY KEY,
    UserId        INT               NOT NULL CONSTRAINT FK_DeviceTokens_Users REFERENCES dbo.Users (UserId),
    FcmToken      NVARCHAR(512)     NOT NULL,
    Platform      NVARCHAR(10)      NOT NULL CONSTRAINT CK_DeviceTokens_Platform CHECK (Platform IN (N'android', N'ios')),
    CreatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_DeviceTokens_CreatedUtc DEFAULT SYSUTCDATETIME(),
    UpdatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_DeviceTokens_UpdatedUtc DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX UX_DeviceTokens_FcmToken ON dbo.DeviceTokens (FcmToken);
CREATE INDEX IX_DeviceTokens_UserId ON dbo.DeviceTokens (UserId);
GO

CREATE TABLE dbo.Attendance (
    AttendanceId      INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Attendance PRIMARY KEY,
    UserId            INT               NOT NULL CONSTRAINT FK_Attendance_Users REFERENCES dbo.Users (UserId),
    WorkDate          DATE              NOT NULL,
    ClockInUtc        DATETIME2(0)      NOT NULL,
    ClockOutUtc       DATETIME2(0)      NULL,
    InLat             DECIMAL(9,6)      NULL,
    InLng             DECIMAL(9,6)      NULL,
    InAccuracy        DECIMAL(9,2)      NULL,
    InDistanceMeters  DECIMAL(12,2)     NULL,
    OutLat            DECIMAL(9,6)      NULL,
    OutLng            DECIMAL(9,6)      NULL,
    OutAccuracy       DECIMAL(9,2)      NULL,
    OutDistanceMeters DECIMAL(12,2)     NULL,
    Method            NVARCHAR(10)      NOT NULL CONSTRAINT CK_Attendance_Method CHECK (Method IN (N'GEOFENCE', N'MANUAL')),
    IsLate            BIT               NOT NULL CONSTRAINT DF_Attendance_IsLate DEFAULT 0,
    ManualReason      NVARCHAR(500)     NULL,
    CreatedBy         INT               NULL CONSTRAINT FK_Attendance_CreatedBy REFERENCES dbo.Users (UserId),
    CreatedUtc        DATETIME2(0)      NOT NULL CONSTRAINT DF_Attendance_CreatedUtc DEFAULT SYSUTCDATETIME(),
    UpdatedUtc        DATETIME2(0)      NOT NULL CONSTRAINT DF_Attendance_UpdatedUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Attendance_ClockOutAfterIn CHECK (ClockOutUtc IS NULL OR ClockOutUtc >= ClockInUtc),
    CONSTRAINT CK_Attendance_ManualReason CHECK (Method <> N'MANUAL' OR ManualReason IS NOT NULL)
);
-- At most one open shift per user, enforced by the database so concurrent clock-ins are safe.
CREATE UNIQUE INDEX UX_Attendance_OpenShift ON dbo.Attendance (UserId) WHERE ClockOutUtc IS NULL;
CREATE UNIQUE INDEX UX_Attendance_UserWorkDate ON dbo.Attendance (UserId, WorkDate);
CREATE INDEX IX_Attendance_WorkDate ON dbo.Attendance (WorkDate) INCLUDE (UserId, ClockInUtc, ClockOutUtc, IsLate);
GO

CREATE TABLE dbo.Tasks (
    TaskId        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Tasks PRIMARY KEY,
    Title         NVARCHAR(200)     NOT NULL,
    Description   NVARCHAR(4000)    NOT NULL CONSTRAINT DF_Tasks_Description DEFAULT N'',
    AssigneeId    INT               NOT NULL CONSTRAINT FK_Tasks_Assignee REFERENCES dbo.Users (UserId),
    CreatedBy     INT               NOT NULL CONSTRAINT FK_Tasks_CreatedBy REFERENCES dbo.Users (UserId),
    Priority      NVARCHAR(10)      NOT NULL CONSTRAINT CK_Tasks_Priority CHECK (Priority IN (N'LOW', N'MEDIUM', N'HIGH')),
    Status        NVARCHAR(20)      NOT NULL CONSTRAINT DF_Tasks_Status DEFAULT N'TODO'
                                    CONSTRAINT CK_Tasks_Status CHECK (Status IN (N'TODO', N'IN_PROGRESS', N'COMPLETED', N'CARRIED_OVER')),
    DueUtc        DATETIME2(0)      NOT NULL,
    DueWorkDate   DATE              NOT NULL,
    CompletedUtc  DATETIME2(0)      NULL,
    CreatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_Tasks_CreatedUtc DEFAULT SYSUTCDATETIME(),
    UpdatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_Tasks_UpdatedUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Tasks_CompletedUtc CHECK ((Status = N'COMPLETED' AND CompletedUtc IS NOT NULL)
                                            OR (Status <> N'COMPLETED' AND CompletedUtc IS NULL))
);
CREATE INDEX IX_Tasks_Assignee_DueWorkDate ON dbo.Tasks (AssigneeId, DueWorkDate) INCLUDE (Status, DueUtc);
CREATE INDEX IX_Tasks_Status ON dbo.Tasks (Status);
CREATE INDEX IX_Tasks_DueWorkDate ON dbo.Tasks (DueWorkDate) INCLUDE (Status);
GO

CREATE TABLE dbo.TaskAttachments (
    AttachmentId  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TaskAttachments PRIMARY KEY,
    TaskId        INT               NOT NULL CONSTRAINT FK_TaskAttachments_Tasks REFERENCES dbo.Tasks (TaskId),
    FileName      NVARCHAR(255)     NOT NULL,
    StoredPath    NVARCHAR(500)     NOT NULL,
    MimeType      NVARCHAR(150)     NOT NULL,
    SizeBytes     BIGINT            NOT NULL,
    UploadedBy    INT               NOT NULL CONSTRAINT FK_TaskAttachments_UploadedBy REFERENCES dbo.Users (UserId),
    UploadedUtc   DATETIME2(0)      NOT NULL CONSTRAINT DF_TaskAttachments_UploadedUtc DEFAULT SYSUTCDATETIME(),
    CreatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_TaskAttachments_CreatedUtc DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_TaskAttachments_TaskId ON dbo.TaskAttachments (TaskId);
GO

CREATE TABLE dbo.DailyReports (
    ReportId      INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DailyReports PRIMARY KEY,
    AttendanceId  INT               NOT NULL CONSTRAINT FK_DailyReports_Attendance REFERENCES dbo.Attendance (AttendanceId),
    UserId        INT               NOT NULL CONSTRAINT FK_DailyReports_Users REFERENCES dbo.Users (UserId),
    Summary       NVARCHAR(2000)    NOT NULL,
    Blockers      NVARCHAR(2000)    NULL,
    Notes         NVARCHAR(2000)    NULL,
    SubmittedUtc  DATETIME2(0)      NOT NULL,
    CreatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_DailyReports_CreatedUtc DEFAULT SYSUTCDATETIME(),
    UpdatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_DailyReports_UpdatedUtc DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX UX_DailyReports_AttendanceId ON dbo.DailyReports (AttendanceId);
CREATE INDEX IX_DailyReports_UserId ON dbo.DailyReports (UserId);
GO

CREATE TABLE dbo.Announcements (
    AnnouncementId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Announcements PRIMARY KEY,
    Title          NVARCHAR(200)     NOT NULL,
    Body           NVARCHAR(MAX)     NOT NULL,
    Category       NVARCHAR(20)      NOT NULL CONSTRAINT CK_Announcements_Category CHECK (Category IN (N'SAFETY', N'GENERAL', N'EVENTS')),
    IsPinned       BIT               NOT NULL CONSTRAINT DF_Announcements_IsPinned DEFAULT 0,
    CreatedBy      INT               NOT NULL CONSTRAINT FK_Announcements_CreatedBy REFERENCES dbo.Users (UserId),
    IsDeleted      BIT               NOT NULL CONSTRAINT DF_Announcements_IsDeleted DEFAULT 0,
    CreatedUtc     DATETIME2(0)      NOT NULL CONSTRAINT DF_Announcements_CreatedUtc DEFAULT SYSUTCDATETIME(),
    UpdatedUtc     DATETIME2(0)      NOT NULL CONSTRAINT DF_Announcements_UpdatedUtc DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Announcements_List ON dbo.Announcements (IsDeleted, IsPinned, CreatedUtc DESC) INCLUDE (Category);
GO

CREATE TABLE dbo.Leaves (
    LeaveId       INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Leaves PRIMARY KEY,
    UserId        INT               NOT NULL CONSTRAINT FK_Leaves_Users REFERENCES dbo.Users (UserId),
    FromDate      DATE              NOT NULL,
    ToDate        DATE              NOT NULL,
    Reason        NVARCHAR(500)     NOT NULL,
    CreatedBy     INT               NOT NULL CONSTRAINT FK_Leaves_CreatedBy REFERENCES dbo.Users (UserId),
    CreatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_Leaves_CreatedUtc DEFAULT SYSUTCDATETIME(),
    UpdatedUtc    DATETIME2(0)      NOT NULL CONSTRAINT DF_Leaves_UpdatedUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Leaves_DateRange CHECK (FromDate <= ToDate)
);
CREATE INDEX IX_Leaves_Dates ON dbo.Leaves (FromDate, ToDate) INCLUDE (UserId);
CREATE INDEX IX_Leaves_UserId ON dbo.Leaves (UserId);
GO
