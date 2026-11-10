import bcrypt from 'bcrypt';
import { fromTimeColumn, isUniqueViolation, withTransaction } from '../../db/pool';
import { realtime } from '../../services/realtime.service';
import { AppError } from '../../utils/AppError';
import { assertShiftOrder } from '../../utils/shift';
import * as authRepo from '../auth/auth.repository';
import { BCRYPT_COST, emailTaken, requireDefaultOffice } from '../auth/auth.service';
import type { AuthUser, Role } from '../auth/auth.types';
import * as devicesRepo from '../devices/devices.repository';
import { toAdminUserDto, type AdminUserDto } from './users.mapper';
import * as usersRepo from './users.repository';
import type { UserRow, UserStatus } from './users.repository';
import type { ApproveUserInput, CreateUserInput, UpdateUserInput } from './users.schemas';

/*
 * Who may do what:
 * - ADMIN manages EMPLOYEE accounts: create, approve / reject sign-ups, rename, remove, reactivate.
 * - SUPER_ADMIN can do all of that, and is the only one who may create, promote, demote or remove admins and
 *   set anyone's shift start and end. (Office location and hours live in the offices module, also super admin only.)
 * - The SUPER_ADMIN account itself is never changed through these endpoints, except renaming yourself.
 * - Nobody changes their own role or removes themselves.
 */

const refuse = (field: string, message: string) =>
  AppError.validation(message, { fields: [{ field, message }] });

function requireSuperAdmin(actor: AuthUser, what: string): void {
  if (actor.role !== 'SUPER_ADMIN') throw AppError.forbidden(`Only the super admin can ${what}`);
}

interface ShiftInput {
  shiftStart?: string;
  shiftEnd?: string;
}

function requireSuperAdminForShift(actor: AuthUser, input: ShiftInput): void {
  if (input.shiftStart !== undefined || input.shiftEnd !== undefined)
    requireSuperAdmin(actor, 'set shift times');
}

/** Checks the shift [user] will have once [input] is applied over their current times. */
function assertUserShift(user: UserRow, input: ShiftInput): void {
  if (input.shiftStart === undefined && input.shiftEnd === undefined) return;
  assertShiftOrder(
    input.shiftStart ?? fromTimeColumn(user.ShiftStart),
    input.shiftEnd ?? fromTimeColumn(user.ShiftEnd),
    'shiftEnd',
  );
}

/** Admins may manage employees; the super admin may also manage admins; nobody manages the super admin. */
function assertCanManage(actor: AuthUser, target: UserRow): void {
  if (target.Role === 'SUPER_ADMIN') throw AppError.forbidden('The super admin account cannot be changed');
  if (target.Role === 'ADMIN') requireSuperAdmin(actor, 'manage admin accounts');
}

/** ACTIVE feeds the assignee dropdown; PENDING and INACTIVE feed the approval and removed-users screens. */
export async function listUsers(status: UserStatus, role?: Role): Promise<AdminUserDto[]> {
  return (await usersRepo.listUsersByStatus(status, role)).map(toAdminUserDto);
}

export async function createUser(actor: AuthUser, input: CreateUserInput): Promise<AdminUserDto> {
  if (input.role === 'ADMIN') requireSuperAdmin(actor, 'create admins');
  requireSuperAdminForShift(actor, input);
  const office = await requireDefaultOffice();
  const shiftStart = input.shiftStart ?? fromTimeColumn(office.DefaultShiftStart);
  const shiftEnd = input.shiftEnd ?? fromTimeColumn(office.DefaultShiftEnd);
  assertShiftOrder(shiftStart, shiftEnd, 'shiftEnd');

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  let id: number;
  try {
    id = await usersRepo.insertUser({
      name: input.name,
      email: input.email,
      passwordHash,
      role: input.role,
      officeId: office.OfficeId,
      shiftStart,
      shiftEnd,
      status: 'ACTIVE',
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken();
    throw err;
  }
  realtime.attendanceChanged(id);
  return requireUserDto(id);
}

export async function updateUser(
  actor: AuthUser,
  userId: number,
  input: UpdateUserInput,
): Promise<AdminUserDto> {
  requireSuperAdminForShift(actor, input);
  if (input.role !== undefined) requireSuperAdmin(actor, 'change roles');

  const before = await withTransaction(async (tx) => {
    const user = await usersRepo.findUserForUpdate(userId, tx);
    if (!user) throw AppError.notFound('User not found');
    if (user.UserId === actor.id) {
      if (input.role !== undefined) throw refuse('role', 'You cannot change your own role');
    } else {
      assertCanManage(actor, user);
    }
    assertUserShift(user, input);
    await usersRepo.updateUser(userId, input, tx);
    return user;
  });

  if (before.Role === 'ADMIN' && input.role === 'EMPLOYEE') realtime.disconnectUser(userId);
  realtime.attendanceChanged(userId);
  return requireUserDto(userId);
}

export async function approveUser(
  actor: AuthUser,
  userId: number,
  shift: ApproveUserInput = {},
): Promise<AdminUserDto> {
  requireSuperAdminForShift(actor, shift);
  await withTransaction(async (tx) => {
    const user = await usersRepo.findUserForUpdate(userId, tx);
    if (!user) throw AppError.notFound('User not found');
    if (user.Status !== 'PENDING') throw refuse('status', 'Only pending sign-ups can be approved');
    assertUserShift(user, shift);
    if (shift.shiftStart || shift.shiftEnd) await usersRepo.updateUser(userId, shift, tx);
    await usersRepo.setUserStatus(userId, 'ACTIVE', tx);
  });
  realtime.attendanceChanged(userId);
  return requireUserDto(userId);
}

/** Rejecting deletes the sign-up outright, so the person may register again later. */
export async function rejectUser(userId: number): Promise<void> {
  const user = await usersRepo.findUserById(userId);
  if (!user) throw AppError.notFound('User not found');
  if (user.Status !== 'PENDING' || !(await usersRepo.deletePendingUser(userId))) {
    throw refuse('status', 'Only pending sign-ups can be rejected');
  }
}

/**
 * Removes a user from the system without deleting their history: they can no longer sign in, every
 * session and device is dropped at once, and they disappear from dashboards and assignee lists.
 */
export async function deactivateUser(actor: AuthUser, userId: number): Promise<AdminUserDto> {
  await withTransaction(async (tx) => {
    const user = await usersRepo.findUserForUpdate(userId, tx);
    if (!user) throw AppError.notFound('User not found');
    if (user.UserId === actor.id) throw refuse('id', 'You cannot remove your own account');
    assertCanManage(actor, user);
    if (user.Status !== 'ACTIVE') throw refuse('status', 'Only active users can be removed');
    await usersRepo.setUserStatus(userId, 'INACTIVE', tx);
    await authRepo.revokeAllRefreshTokens(userId, tx);
    await devicesRepo.deleteTokensForUser(userId, tx);
  });
  realtime.disconnectUser(userId);
  realtime.attendanceChanged(userId);
  return requireUserDto(userId);
}

export async function reactivateUser(actor: AuthUser, userId: number): Promise<AdminUserDto> {
  await withTransaction(async (tx) => {
    const user = await usersRepo.findUserForUpdate(userId, tx);
    if (!user) throw AppError.notFound('User not found');
    assertCanManage(actor, user);
    if (user.Status !== 'INACTIVE') throw refuse('status', 'Only removed users can be reactivated');
    await usersRepo.setUserStatus(userId, 'ACTIVE', tx);
  });
  realtime.attendanceChanged(userId);
  return requireUserDto(userId);
}

async function requireUserDto(userId: number): Promise<AdminUserDto> {
  const user = await usersRepo.findUserById(userId);
  if (!user) throw AppError.notFound('User not found');
  return toAdminUserDto(user);
}
