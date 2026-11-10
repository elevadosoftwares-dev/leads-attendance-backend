import { createRequest, dateParam, sql, type Queryable } from '../../db/pool';

export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export interface LeaveRow {
  LeaveId: number;
  UserId: number;
  UserName: string;
  FromDate: Date;
  ToDate: Date;
  Reason: string;
  Status: LeaveStatus;
  CreatedUtc: Date;
  CreatedBy: number;
  CreatedByName: string;
  ReviewedBy: number | null;
  ReviewedByName: string | null;
  ReviewedUtc: Date | null;
  ReviewNote: string | null;
}

const LEAVE_SELECT = `
  SELECT l.LeaveId, l.UserId, u.Name AS UserName, l.FromDate, l.ToDate, l.Reason, l.Status, l.CreatedUtc,
         l.CreatedBy, c.Name AS CreatedByName, l.ReviewedBy, r.Name AS ReviewedByName, l.ReviewedUtc, l.ReviewNote
    FROM dbo.Leaves l
    JOIN dbo.Users u ON u.UserId = l.UserId
    JOIN dbo.Users c ON c.UserId = l.CreatedBy
    LEFT JOIN dbo.Users r ON r.UserId = l.ReviewedBy`;

/** Approved leave covering the date. */
export async function listLeavesCovering(workDate: string): Promise<LeaveRow[]> {
  const request = await createRequest();
  const result = await request.input('date', sql.Date, dateParam(workDate)).query<LeaveRow>(
    `${LEAVE_SELECT}
        WHERE l.Status = N'APPROVED' AND @date BETWEEN l.FromDate AND l.ToDate
        ORDER BY u.Name, l.FromDate`,
  );
  return result.recordset;
}

/**
 * Leave in one status. PENDING and APPROVED list what is still current (ending on or after [today]), soonest
 * first; REJECTED and CANCELLED list the most recent 100.
 */
export async function listLeavesByStatus(status: LeaveStatus, today: string): Promise<LeaveRow[]> {
  const current = status === 'PENDING' || status === 'APPROVED';
  const request = await createRequest();
  const result = await request
    .input('status', sql.NVarChar(20), status)
    .input('today', sql.Date, dateParam(today))
    .query<LeaveRow>(
      current
        ? `${LEAVE_SELECT} WHERE l.Status = @status AND l.ToDate >= @today ORDER BY l.FromDate, u.Name`
        : `SELECT TOP (100) * FROM (${LEAVE_SELECT} WHERE l.Status = @status) x
            ORDER BY x.FromDate DESC, x.LeaveId DESC`,
    );
  return result.recordset;
}

/** One employee's leave, newest first. */
export async function listLeavesForUser(userId: number): Promise<LeaveRow[]> {
  const request = await createRequest();
  const result = await request.input('userId', sql.Int, userId).query<LeaveRow>(
    `SELECT TOP (100) * FROM (${LEAVE_SELECT} WHERE l.UserId = @userId) x
        ORDER BY x.FromDate DESC, x.LeaveId DESC`,
  );
  return result.recordset;
}

/** One employee's approved leave overlapping [from, to]. */
export async function listApprovedLeavesInRange(
  userId: number,
  from: string,
  to: string,
): Promise<LeaveRow[]> {
  const request = await createRequest();
  const result = await request
    .input('userId', sql.Int, userId)
    .input('from', sql.Date, dateParam(from))
    .input('to', sql.Date, dateParam(to))
    .query<LeaveRow>(
      `${LEAVE_SELECT}
        WHERE l.UserId = @userId AND l.Status = N'APPROVED' AND l.FromDate <= @to AND l.ToDate >= @from
        ORDER BY l.FromDate`,
    );
  return result.recordset;
}

export async function findLeave(leaveId: number, db?: Queryable): Promise<LeaveRow | null> {
  const request = await createRequest(db);
  const result = await request
    .input('id', sql.Int, leaveId)
    .query<LeaveRow>(`${LEAVE_SELECT} WHERE l.LeaveId = @id`);
  return result.recordset[0] ?? null;
}

/** Locks the leave row for the rest of the transaction. */
export async function findLeaveForUpdate(leaveId: number, db: Queryable): Promise<LeaveRow | null> {
  const request = await createRequest(db);
  const result = await request.input('id', sql.Int, leaveId).query<LeaveRow>(
    `${LEAVE_SELECT.replace('FROM dbo.Leaves l', 'FROM dbo.Leaves l WITH (UPDLOCK, ROWLOCK)')}
      WHERE l.LeaveId = @id`,
  );
  return result.recordset[0] ?? null;
}

/**
 * True if a pending or approved leave of the user overlaps the range (locks the range in a transaction).
 * Rejected and cancelled leave never blocks a new one.
 */
export async function hasOverlappingLeave(
  userId: number,
  fromDate: string,
  toDate: string,
  db: Queryable,
): Promise<boolean> {
  const request = await createRequest(db);
  const result = await request
    .input('userId', sql.Int, userId)
    .input('from', sql.Date, dateParam(fromDate))
    .input('to', sql.Date, dateParam(toDate))
    .query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM dbo.Leaves WITH (UPDLOCK, HOLDLOCK)
        WHERE UserId = @userId AND Status IN (N'PENDING', N'APPROVED') AND FromDate <= @to AND ToDate >= @from`,
    );
  return result.recordset[0]!.n > 0;
}

export interface NewLeave {
  userId: number;
  fromDate: string;
  toDate: string;
  reason: string;
  createdBy: number;
  status: 'PENDING' | 'APPROVED';
  /** Set when an admin records the leave directly (it is approved by them). */
  reviewedBy: number | null;
}

export async function insertLeave(leave: NewLeave, db: Queryable): Promise<number> {
  const request = await createRequest(db);
  const result = await request
    .input('userId', sql.Int, leave.userId)
    .input('from', sql.Date, dateParam(leave.fromDate))
    .input('to', sql.Date, dateParam(leave.toDate))
    .input('reason', sql.NVarChar(500), leave.reason)
    .input('createdBy', sql.Int, leave.createdBy)
    .input('status', sql.NVarChar(20), leave.status)
    .input('reviewedBy', sql.Int, leave.reviewedBy)
    .query<{ LeaveId: number }>(
      `INSERT INTO dbo.Leaves (UserId, FromDate, ToDate, Reason, CreatedBy, Status, ReviewedBy, ReviewedUtc)
       OUTPUT INSERTED.LeaveId
       VALUES (@userId, @from, @to, @reason, @createdBy, @status, @reviewedBy,
               CASE WHEN @reviewedBy IS NULL THEN NULL ELSE SYSUTCDATETIME() END)`,
    );
  return result.recordset[0]!.LeaveId;
}

export async function setLeaveStatus(
  leaveId: number,
  change: { status: LeaveStatus; reviewedBy: number; note: string | null },
  db: Queryable,
): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('id', sql.Int, leaveId)
    .input('status', sql.NVarChar(20), change.status)
    .input('reviewedBy', sql.Int, change.reviewedBy)
    .input('note', sql.NVarChar(500), change.note)
    .query(
      `UPDATE dbo.Leaves
       SET Status = @status, ReviewedBy = @reviewedBy, ReviewedUtc = SYSUTCDATETIME(),
           ReviewNote = COALESCE(@note, ReviewNote), UpdatedUtc = SYSUTCDATETIME()
       WHERE LeaveId = @id`,
    );
}
