-- Leave gains a lifecycle so employees can request it: PENDING (requested, awaiting an admin) -> APPROVED or
-- REJECTED, and PENDING / APPROVED -> CANCELLED (withdrawn or cancelled; the row is kept for history).
-- Only APPROVED leave counts as "on leave". Leave recorded before this migration was entered by an admin, so it
-- is APPROVED.
ALTER TABLE dbo.Leaves ADD
    Status      NVARCHAR(20)  NOT NULL CONSTRAINT DF_Leaves_Status DEFAULT N'APPROVED'
                              CONSTRAINT CK_Leaves_Status CHECK (Status IN (N'PENDING', N'APPROVED', N'REJECTED', N'CANCELLED')),
    ReviewedBy  INT           NULL CONSTRAINT FK_Leaves_ReviewedBy REFERENCES dbo.Users (UserId),
    ReviewedUtc DATETIME2(0)  NULL,
    ReviewNote  NVARCHAR(500) NULL;
GO
CREATE INDEX IX_Leaves_Status ON dbo.Leaves (Status, FromDate) INCLUDE (UserId, ToDate);
GO
