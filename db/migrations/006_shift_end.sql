-- Shift end joins shift start: an office default (given to new users) and a per-user value, both set by the
-- super admin. Existing offices and users get 18:00.
ALTER TABLE dbo.Offices ADD
    DefaultShiftEnd TIME(0) NOT NULL CONSTRAINT DF_Offices_DefaultShiftEnd DEFAULT '18:00';
GO
ALTER TABLE dbo.Users ADD
    ShiftEnd TIME(0) NOT NULL CONSTRAINT DF_Users_ShiftEnd DEFAULT '18:00';
GO
