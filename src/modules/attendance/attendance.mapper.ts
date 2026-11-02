import { fromDateColumn } from '../../db/pool';
import { isoUtc } from '../../utils/time';
import type { AttendanceRow } from './attendance.repository';

export interface AttendanceDto {
  id: number;
  workDate: string;
  clockInUtc: string;
  clockOutUtc: string | null;
  durationMinutes: number | null;
  method: 'GEOFENCE' | 'MANUAL';
  isLate: boolean;
  clockInDistanceMeters: number | null;
}

export function toAttendanceDto(row: AttendanceRow): AttendanceDto {
  return {
    id: row.AttendanceId,
    workDate: fromDateColumn(row.WorkDate),
    clockInUtc: isoUtc(row.ClockInUtc),
    clockOutUtc: isoUtc(row.ClockOutUtc),
    durationMinutes: row.DurationMinutes,
    method: row.Method,
    isLate: row.IsLate,
    clockInDistanceMeters: row.InDistanceMeters === null ? null : Math.round(Number(row.InDistanceMeters)),
  };
}
