import { createRequest, dateParam, sql } from '../../db/pool';

export interface LiveRow {
  UserId: number;
  Name: string;
  ClockInUtc: Date | null;
  ClockOutUtc: Date | null;
  IsLate: boolean | null;
  OnLeave: boolean;
}

/** Every active employee with today's attendance record (if any) and whether approved leave covers today. */
export async function listLiveRows(workDate: string, userId?: number): Promise<LiveRow[]> {
  const request = await createRequest();
  const result = await request
    .input('date', sql.Date, dateParam(workDate))
    .input('userId', sql.Int, userId ?? null)
    .query<LiveRow>(
      `SELECT u.UserId, u.Name, a.ClockInUtc, a.ClockOutUtc, a.IsLate,
              CAST(CASE WHEN EXISTS (
                SELECT 1 FROM dbo.Leaves l
                 WHERE l.UserId = u.UserId AND l.Status = N'APPROVED' AND @date BETWEEN l.FromDate AND l.ToDate
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
