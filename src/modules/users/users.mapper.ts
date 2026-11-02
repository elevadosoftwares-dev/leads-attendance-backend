import { fromTimeColumn } from '../../db/pool';
import { initialsOf } from '../../utils/format';
import type { Role } from '../auth/auth.types';
import type { UserRow } from './users.repository';

export interface UserDto {
  id: number;
  name: string;
  email: string;
  role: Role;
  initials: string;
  shiftStart: string;
  officeId: number;
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
    officeId: row.OfficeId,
  };
}

export function userRef(id: number, name: string): UserRef {
  return { id, name, initials: initialsOf(name) };
}
