import { fromTimeColumn } from '../../db/pool';
import { initialsOf } from '../../utils/format';
import type { Role } from '../auth/auth.types';
import { companyTimezone, isoUtc } from '../../utils/time';
import type { UserRow, UserStatus } from './users.repository';

export interface UserDto {
  id: number;
  name: string;
  email: string;
  role: Role;
  initials: string;
  shiftStart: string;
  shiftEnd: string;
  officeId: number;
  /** The company timezone (IANA name) that the app shows times in. */
  timezone: string;
}

export interface UserRef {
  id: number;
  name: string;
  initials: string;
}

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.UserId,
    name: row.Name,
    email: row.Email,
    role: row.Role,
    initials: initialsOf(row.Name),
    shiftStart: fromTimeColumn(row.ShiftStart),
    shiftEnd: fromTimeColumn(row.ShiftEnd),
    officeId: row.OfficeId,
    timezone: companyTimezone(),
  };
}

export function userRef(id: number, name: string): UserRef {
  return { id, name, initials: initialsOf(name) };
}

/** A user as the admin user-management screens see it. */
export interface AdminUserDto {
  id: number;
  name: string;
  email: string;
  role: Role;
  initials: string;
  status: UserStatus;
  shiftStart: string;
  shiftEnd: string;
  createdUtc: string;
}

export function toAdminUserDto(row: UserRow): AdminUserDto {
  return {
    id: row.UserId,
    name: row.Name,
    email: row.Email,
    role: row.Role,
    initials: initialsOf(row.Name),
    status: row.Status,
    shiftStart: fromTimeColumn(row.ShiftStart),
    shiftEnd: fromTimeColumn(row.ShiftEnd),
    createdUtc: isoUtc(row.CreatedUtc),
  };
}
