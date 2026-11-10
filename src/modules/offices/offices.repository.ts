import { createRequest, fromTimeColumn, sql, type Queryable } from '../../db/pool';
import { isoUtc } from '../../utils/time';

export interface OfficeRow {
  OfficeId: number;
  Name: string;
  Address: string;
  Latitude: number;
  Longitude: number;
  RadiusMeters: number;
  DefaultShiftStart: Date;
  DefaultShiftEnd: Date;
  LateGraceMinutes: number;
  Timezone: string;
  UpdatedUtc: Date;
}

const OFFICE_COLUMNS =
  'o.OfficeId, o.Name, o.Address, o.Latitude, o.Longitude, o.RadiusMeters, o.DefaultShiftStart, o.DefaultShiftEnd, o.LateGraceMinutes, o.Timezone, o.UpdatedUtc';

/** The office as employees see it (geofence only). */
export interface OfficeDto {
  id: number;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

/** Everything the super admin controls: location, geofence and working time. */
export interface OfficeSettingsDto extends OfficeDto {
  defaultShiftStart: string;
  defaultShiftEnd: string;
  lateGraceMinutes: number;
  /** IANA name, e.g. `Asia/Singapore`: the company timezone for work dates, lateness and displayed times. */
  timezone: string;
  updatedUtc: string;
}

export function toOfficeDto(row: OfficeRow): OfficeDto {
  return {
    id: row.OfficeId,
    name: row.Name,
    address: row.Address,
    latitude: Number(row.Latitude),
    longitude: Number(row.Longitude),
    radiusMeters: row.RadiusMeters,
  };
}

export function toOfficeSettingsDto(row: OfficeRow): OfficeSettingsDto {
  return {
    ...toOfficeDto(row),
    defaultShiftStart: fromTimeColumn(row.DefaultShiftStart),
    defaultShiftEnd: fromTimeColumn(row.DefaultShiftEnd),
    lateGraceMinutes: row.LateGraceMinutes,
    timezone: row.Timezone,
    updatedUtc: isoUtc(row.UpdatedUtc),
  };
}

export async function findOfficeForUser(userId: number, db?: Queryable): Promise<OfficeRow | null> {
  const request = await createRequest(db);
  const result = await request.input('userId', sql.Int, userId).query<OfficeRow>(
    `SELECT ${OFFICE_COLUMNS}
       FROM dbo.Users u JOIN dbo.Offices o ON o.OfficeId = u.OfficeId
      WHERE u.UserId = @userId`,
  );
  return result.recordset[0] ?? null;
}

/** The office new users join: the first one created (the system currently has a single office). */
export async function findDefaultOffice(db?: Queryable): Promise<OfficeRow | null> {
  const request = await createRequest(db);
  const result = await request.query<OfficeRow>(
    `SELECT TOP (1) ${OFFICE_COLUMNS} FROM dbo.Offices o ORDER BY o.OfficeId`,
  );
  return result.recordset[0] ?? null;
}

export interface OfficeChanges {
  name?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  defaultShiftStart?: string;
  defaultShiftEnd?: string;
  lateGraceMinutes?: number;
  timezone?: string;
}

export async function updateOffice(officeId: number, changes: OfficeChanges, db?: Queryable): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('officeId', sql.Int, officeId)
    .input('name', sql.NVarChar(150), changes.name ?? null)
    .input('address', sql.NVarChar(300), changes.address ?? null)
    .input('lat', sql.Decimal(9, 6), changes.latitude ?? null)
    .input('lng', sql.Decimal(9, 6), changes.longitude ?? null)
    .input('radius', sql.Int, changes.radiusMeters ?? null)
    .input('shiftStart', sql.VarChar(5), changes.defaultShiftStart ?? null)
    .input('shiftEnd', sql.VarChar(5), changes.defaultShiftEnd ?? null)
    .input('grace', sql.Int, changes.lateGraceMinutes ?? null)
    .input('timezone', sql.NVarChar(64), changes.timezone ?? null)
    .query(
      `UPDATE dbo.Offices
       SET Name = COALESCE(@name, Name),
           Address = COALESCE(@address, Address),
           Latitude = COALESCE(@lat, Latitude),
           Longitude = COALESCE(@lng, Longitude),
           RadiusMeters = COALESCE(@radius, RadiusMeters),
           DefaultShiftStart = COALESCE(CAST(@shiftStart AS TIME(0)), DefaultShiftStart),
           DefaultShiftEnd = COALESCE(CAST(@shiftEnd AS TIME(0)), DefaultShiftEnd),
           LateGraceMinutes = COALESCE(@grace, LateGraceMinutes),
           Timezone = COALESCE(@timezone, Timezone),
           UpdatedUtc = SYSUTCDATETIME()
       WHERE OfficeId = @officeId`,
    );
}

/** Gives every user of the office the same shift (used when the office hours change). */
export async function setShiftForOffice(
  officeId: number,
  shift: { shiftStart: string; shiftEnd: string },
  db?: Queryable,
): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('officeId', sql.Int, officeId)
    .input('shiftStart', sql.VarChar(5), shift.shiftStart)
    .input('shiftEnd', sql.VarChar(5), shift.shiftEnd)
    .query(
      `UPDATE dbo.Users
       SET ShiftStart = CAST(@shiftStart AS TIME(0)), ShiftEnd = CAST(@shiftEnd AS TIME(0)),
           UpdatedUtc = SYSUTCDATETIME()
       WHERE OfficeId = @officeId`,
    );
}
