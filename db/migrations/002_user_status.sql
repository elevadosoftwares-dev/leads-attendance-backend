-- Account lifecycle: self sign-ups wait as PENDING until an admin approves them; removed users become INACTIVE.
-- IsActive stays as the login/visibility gate and is kept equal to (Status = 'ACTIVE') by a constraint.
ALTER TABLE dbo.Users ADD Status NVARCHAR(20) NOT NULL
    CONSTRAINT DF_Users_Status DEFAULT N'ACTIVE'
    CONSTRAINT CK_Users_Status CHECK (Status IN (N'PENDING', N'ACTIVE', N'INACTIVE'));
GO

UPDATE dbo.Users SET Status = N'INACTIVE' WHERE IsActive = 0;
GO

ALTER TABLE dbo.Users ADD CONSTRAINT CK_Users_StatusMatchesIsActive
    CHECK ((Status = N'ACTIVE' AND IsActive = 1) OR (Status <> N'ACTIVE' AND IsActive = 0));
GO

CREATE INDEX IX_Users_Status ON dbo.Users (Status, Name);
GO
