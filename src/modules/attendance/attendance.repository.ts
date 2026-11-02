import { createRequest, dateParam, sql, type Queryable } from '../../db/pool';

export interface AttendanceRow {
  AttendanceId: number;
  UserId: number;
  WorkDate: Date;
  ClockInUtc: Date;
  ClockOutUtc: Date | null;
  DurationMinutes: number | null;
  Method: 'GEOFENCE' | 'MANUAL';
  IsLate: boolean;
  InDistanceMeters: number | null;
}

const ATTENDANCE_COLUMNS = `
  a.AttendanceId, a.UserId, a.WorkDate, a.ClockInUtc, a.ClockOutUtc,
  CASE WHEN a.ClockOutUtc IS NULL THEN NULL ELSE DATEDIFF(MINUTE, a.ClockInUtc, a.ClockOutUtc) END AS DurationMinutes,
  a.Method, a.IsLate, a.InDistanceMeters`;

/** The user's open shift, if any. `lock` takes an update lock for the rest of the transaction. */
export async function findOpenShift(
  userId: number,
  db?: Queryable,
  opts: { lock?: boolean } = {},
): Promise<AttendanceRow | null> {
  const request = await createRequest(db);
  const hint = opts.lock ? 'WITH (UPDLOCK, HOLDLOCK)' : '';
  const result = await request
    .input('userId', sql.Int, userId)
    .query<AttendanceRow>(
      `SELECT ${ATTENDANCE_COLUMNS} FROM dbo.Attendance a ${hint} WHERE a.UserId = @userId AND a.ClockOutUtc IS NULL`,
    );
  return result.recordset[0] ?? null;
}

export async function findAttendanceByUserAndDate(
  userId: number,
  workDate: string,
  db?: Queryable,
): Promise<AttendanceRow | null> {
  const request = await createRequest(db);
  const result = await request
    .input('userId', sql.Int, userId)
    .input('workDate', sql.Date, dateParam(workDate))
    .query<AttendanceRow>(
      `SELECT ${ATTENDANCE_COLUMNS} FROM dbo.Attendance a WHERE a.UserId = @userId AND a.WorkDate = @workDate`,
    );
  return result.recordset[0] ?? null;
}

export async function findAttendanceById(
  attendanceId: number,
  db?: Queryable,
): Promise<AttendanceRow | null> {
  const request = await createRequest(db);
  const result = await request
    .input('id', sql.Int, attendanceId)
    .query<AttendanceRow>(`SELECT ${ATTENDANCE_COLUMNS} FROM dbo.Attendance a WHERE a.AttendanceId = @id`);
  return result.recordset[0] ?? null;
}

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  distanceMeters: number;
}

export async function insertGeofenceClockIn(
  userId: number,
  workDate: string,
  clockInUtc: Date,
  isLate: boolean,
  location: LocationFix,
): Promise<number> {
  const request = await createRequest();
  const result = await request
    .input('userId', sql.Int, userId)
    .input('workDate', sql.Date, dateParam(workDate))
    .input('clockIn', sql.DateTime2(0), clockInUtc)
    .input('lat', sql.Decimal(9, 6), location.latitude)
    .input('lng', sql.Decimal(9, 6), location.longitude)
    .input('accuracy', sql.Decimal(9, 2), location.accuracy)
    .input('distance', sql.Decimal(12, 2), location.distanceMeters)
    .input('isLate', sql.Bit, isLate)
    .query<{ AttendanceId: number }>(
      `INSERT INTO dbo.Attendance (UserId, WorkDate, ClockInUtc, InLat, InLng, InAccuracy, InDistanceMeters, Method, IsLate)
       OUTPUT INSERTED.AttendanceId
       VALUES (@userId, @workDate, @clockIn, @lat, @lng, @accuracy, @distance, N'GEOFENCE', @isLate)`,
    );
  return result.recordset[0]!.AttendanceId;
}

export async function closeShift(
  attendanceId: number,
  clockOutUtc: Date,
  location: LocationFix | null,
  db?: Queryable,
): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('id', sql.Int, attendanceId)
    .input('clockOut', sql.DateTime2(0), clockOutUtc)
    .input('lat', sql.Decimal(9, 6), location?.latitude ?? null)
    .input('lng', sql.Decimal(9, 6), location?.longitude ?? null)
    .input('accuracy', sql.Decimal(9, 2), location?.accuracy ?? null)
    .input('distance', sql.Decimal(12, 2), location?.distanceMeters ?? null)
    .query(
      `UPDATE dbo.Attendance
          SET ClockOutUtc = @clockOut, OutLat = @lat, OutLng = @lng, OutAccuracy = @accuracy,
              OutDistanceMeters = @distance, UpdatedUtc = SYSUTCDATETIME()
        WHERE AttendanceId = @id AND ClockOutUtc IS NULL`,
    );
}

export interface ManualAttendance {
  userId: number;
  workDate: string;
  clockInUtc: Date;
  clockOutUtc: Date | null;
  isLate: boolean;
  reason: string;
  createdBy: number;
}

export async function insertManualAttendance(record: ManualAttendance, db?: Queryable): Promise<number> {
  const request = await createRequest(db);
  const result = await request
    .input('userId', sql.Int, record.userId)
    .input('workDate', sql.Date, dateParam(record.workDate))
    .input('clockIn', sql.DateTime2(0), record.clockInUtc)
    .input('clockOut', sql.DateTime2(0), record.clockOutUtc)
    .input('isLate', sql.Bit, record.isLate)
    .input('reason', sql.NVarChar(500), record.reason)
    .input('createdBy', sql.Int, record.createdBy)
    .query<{ AttendanceId: number }>(
      `INSERT INTO dbo.Attendance (UserId, WorkDate, ClockInUtc, ClockOutUtc, Method, IsLate, ManualReason, CreatedBy)
       OUTPUT INSERTED.AttendanceId
       VALUES (@userId, @workDate, @clockIn, @clockOut, N'MANUAL', @isLate, @reason, @createdBy)`,
    );
  return result.recordset[0]!.AttendanceId;
}

export interface DailyReportInput {
  attendanceId: number;
  userId: number;
  summary: string;
  blockers: string | null;
  notes: string | null;
  submittedUtc: Date;
}

export async function insertDailyReport(report: DailyReportInput, db?: Queryable): Promise<number> {
  const request = await createRequest(db);
  const result = await request
    .input('attendanceId', sql.Int, report.attendanceId)
    .input('userId', sql.Int, report.userId)
    .input('summary', sql.NVarChar(2000), report.summary)
    .input('blockers', sql.NVarChar(2000), report.blockers)
    .input('notes', sql.NVarChar(2000), report.notes)
    .input('submitted', sql.DateTime2(0), report.submittedUtc)
    .query<{ ReportId: number }>(
      `INSERT INTO dbo.DailyReports (AttendanceId, UserId, Summary, Blockers, Notes, SubmittedUtc)
       OUTPUT INSERTED.ReportId
       VALUES (@attendanceId, @userId, @summary, @blockers, @notes, @submitted)`,
    );
  return result.recordset[0]!.ReportId;
}

export interface HistoryRow extends AttendanceRow {
  TasksTotal: number;
  TasksCompleted: number;
}

export async function listHistory(userId: number, from: string, to: string): Promise<HistoryRow[]> {
  const request = await createRequest();
  const result = await request
    .input('userId', sql.Int, userId)
    .input('from', sql.Date, dateParam(from))
    .input('to', sql.Date, dateParam(to))
    .query<HistoryRow>(
      `SELECT ${ATTENDANCE_COLUMNS}, ISNULL(t.Total, 0) AS TasksTotal, ISNULL(t.Completed, 0) AS TasksCompleted
         FROM dbo.Attendance a
         OUTER APPLY (
           SELECT COUNT(*) AS Total, SUM(CASE WHEN tk.Status = N'COMPLETED' THEN 1 ELSE 0 END) AS Completed
             FROM dbo.Tasks tk
            WHERE tk.AssigneeId = a.UserId AND tk.DueWorkDate = a.WorkDate
         ) t
        WHERE a.UserId = @userId AND a.WorkDate BETWEEN @from AND @to
        ORDER BY a.WorkDate DESC`,
    );
  return result.recordset;
}

/** Open shifts whose work date is on or before `workDate` (for the auto clock-out job). */
export async function listOpenShiftsUpTo(workDate: string): Promise<AttendanceRow[]> {
  const request = await createRequest();
  const result = await request
    .input('workDate', sql.Date, dateParam(workDate))
    .query<AttendanceRow>(
      `SELECT ${ATTENDANCE_COLUMNS} FROM dbo.Attendance a WHERE a.ClockOutUtc IS NULL AND a.WorkDate <= @workDate`,
    );
  return result.recordset;
}

export async function hasDailyReport(attendanceId: number, db?: Queryable): Promise<boolean> {
  const request = await createRequest(db);
  const result = await request
    .input('id', sql.Int, attendanceId)
    .query<{ n: number }>('SELECT COUNT(*) AS n FROM dbo.DailyReports WHERE AttendanceId = @id');
  return result.recordset[0]!.n > 0;
}
