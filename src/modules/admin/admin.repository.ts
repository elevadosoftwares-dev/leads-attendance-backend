import { createRequest, dateParam, sql, type Queryable } from '../../db/pool';

export interface LiveRow {
  UserId: number;
  Name: string;
  ClockInUtc: Date | null;
  ClockOutUtc: Date | null;
  IsLate: boolean | null;
  OnLeave: boolean;
}

/** Every active employee with today's attendance record (if any) and whether a leave covers today. */
export async function listLiveRows(workDate: string, userId?: number): Promise<LiveRow[]> {
  const request = await createRequest();
  const result = await request
    .input('date', sql.Date, dateParam(workDate))
    .input('userId', sql.Int, userId ?? null)
    .query<LiveRow>(
      `SELECT u.UserId, u.Name, a.ClockInUtc, a.ClockOutUtc, a.IsLate,
              CAST(CASE WHEN EXISTS (
                SELECT 1 FROM dbo.Leaves l WHERE l.UserId = u.UserId AND @date BETWEEN l.FromDate AND l.ToDate
              ) THEN 1 ELSE 0 END AS BIT) AS OnLeave
         FROM dbo.Users u
         LEFT JOIN dbo.Attendance a ON a.UserId = u.UserId AND a.WorkDate = @date
        WHERE u.IsActive = 1 AND u.Role = N'EMPLOYEE' AND (@userId IS NULL OR u.UserId = @userId)
        ORDER BY u.Name, u.UserId`,
    );
  return result.recordset;
}

export interface ReportRow {
  ReportId: number;
  UserId: number;
  Name: string;
  Summary: string;
  Blockers: string | null;
  Notes: string | null;
  SubmittedUtc: Date;
  DurationMinutes: number | null;
}

export async function listReports(workDate: string): Promise<ReportRow[]> {
  const request = await createRequest();
  const result = await request.input('date', sql.Date, dateParam(workDate)).query<ReportRow>(
    `SELECT r.ReportId, u.UserId, u.Name, r.Summary, r.Blockers, r.Notes, r.SubmittedUtc,
            CASE WHEN a.ClockOutUtc IS NULL THEN NULL ELSE DATEDIFF(MINUTE, a.ClockInUtc, a.ClockOutUtc) END
              AS DurationMinutes
       FROM dbo.DailyReports r
       JOIN dbo.Attendance a ON a.AttendanceId = r.AttendanceId
       JOIN dbo.Users u ON u.UserId = r.UserId
      WHERE a.WorkDate = @date
      ORDER BY r.SubmittedUtc DESC, r.ReportId DESC`,
  );
  return result.recordset;
}

export interface LeaveRow {
  LeaveId: number;
  UserId: number;
  UserName: string;
  FromDate: Date;
  ToDate: Date;
  Reason: string;
  CreatedUtc: Date;
  CreatedBy: number;
  CreatedByName: string;
}

const LEAVE_SELECT = `
  SELECT l.LeaveId, l.UserId, u.Name AS UserName, l.FromDate, l.ToDate, l.Reason, l.CreatedUtc,
         l.CreatedBy, c.Name AS CreatedByName
    FROM dbo.Leaves l
    JOIN dbo.Users u ON u.UserId = l.UserId
    JOIN dbo.Users c ON c.UserId = l.CreatedBy`;

export async function listLeavesCovering(workDate: string): Promise<LeaveRow[]> {
  const request = await createRequest();
  const result = await request
    .input('date', sql.Date, dateParam(workDate))
    .query<LeaveRow>(
      `${LEAVE_SELECT} WHERE @date BETWEEN l.FromDate AND l.ToDate ORDER BY u.Name, l.FromDate`,
    );
  return result.recordset;
}

export async function findLeave(leaveId: number): Promise<LeaveRow | null> {
  const request = await createRequest();
  const result = await request
    .input('id', sql.Int, leaveId)
    .query<LeaveRow>(`${LEAVE_SELECT} WHERE l.LeaveId = @id`);
  return result.recordset[0] ?? null;
}

/** True if any existing leave for the user overlaps the given range (locks the range in a transaction). */
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
        WHERE UserId = @userId AND FromDate <= @to AND ToDate >= @from`,
    );
  return result.recordset[0]!.n > 0;
}

export async function insertLeave(
  leave: { userId: number; fromDate: string; toDate: string; reason: string; createdBy: number },
  db: Queryable,
): Promise<number> {
  const request = await createRequest(db);
  const result = await request
    .input('userId', sql.Int, leave.userId)
    .input('from', sql.Date, dateParam(leave.fromDate))
    .input('to', sql.Date, dateParam(leave.toDate))
    .input('reason', sql.NVarChar(500), leave.reason)
    .input('createdBy', sql.Int, leave.createdBy)
    .query<{ LeaveId: number }>(
      `INSERT INTO dbo.Leaves (UserId, FromDate, ToDate, Reason, CreatedBy)
       OUTPUT INSERTED.LeaveId
       VALUES (@userId, @from, @to, @reason, @createdBy)`,
    );
  return result.recordset[0]!.LeaveId;
}
