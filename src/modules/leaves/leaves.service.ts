import { fromDateColumn, withTransaction } from '../../db/pool';
import { pushService } from '../../services/push.service';
import { realtime } from '../../services/realtime.service';
import { AppError } from '../../utils/AppError';
import { isoUtc, todayWorkDate } from '../../utils/time';
import { ADMIN_ROLES } from '../auth/auth.types';
import { userRef, type UserRef } from '../users/users.mapper';
import { findUserById } from '../users/users.repository';
import * as repo from './leaves.repository';
import type { LeaveStatus } from './leaves.repository';
import type { CreateLeaveInput, ListLeavesQuery, RequestLeaveInput } from './leaves.schemas';

/*
 * Leave lifecycle:
 * - An admin records leave for an employee: APPROVED at once.
 * - An employee requests leave from today on: PENDING until an admin approves or rejects it.
 * - An admin may cancel pending or approved leave that hasn't ended; the employee may withdraw their own pending
 *   leave, or approved leave that hasn't started. Cancelled rows are kept.
 * Only APPROVED leave counts as "on leave" (dashboard, live attendance, shift reminders, history).
 */

export interface LeaveDto {
  id: number;
  userId: number;
  user: UserRef;
  fromDate: string;
  toDate: string;
  /** Calendar days, both ends included. */
  days: number;
  reason: string;
  status: LeaveStatus;
  createdUtc: string;
  createdBy: { id: number; name: string };
  reviewedBy: { id: number; name: string } | null;
  reviewedUtc: string | null;
  reviewNote: string | null;
}

const DAY_MS = 86_400_000;

export function toLeaveDto(row: repo.LeaveRow): LeaveDto {
  const fromDate = fromDateColumn(row.FromDate);
  const toDate = fromDateColumn(row.ToDate);
  return {
    id: row.LeaveId,
    userId: row.UserId,
    user: userRef(row.UserId, row.UserName),
    fromDate,
    toDate,
    days: Math.round((Date.parse(toDate) - Date.parse(fromDate)) / DAY_MS) + 1,
    reason: row.Reason,
    status: row.Status,
    createdUtc: isoUtc(row.CreatedUtc),
    createdBy: { id: row.CreatedBy, name: row.CreatedByName },
    reviewedBy: row.ReviewedBy === null ? null : { id: row.ReviewedBy, name: row.ReviewedByName ?? '' },
    reviewedUtc: isoUtc(row.ReviewedUtc),
    reviewNote: row.ReviewNote,
  };
}

const refuse = (field: string, message: string) =>
  AppError.validation(message, { fields: [{ field, message }] });

const covers = (leave: { fromDate: string; toDate: string }, date: string) =>
  leave.fromDate <= date && date <= leave.toDate;

const dateLabel = (leave: LeaveDto) =>
  leave.fromDate === leave.toDate ? leave.fromDate : `${leave.fromDate} to ${leave.toDate}`;

async function requireEmployee(userId: number) {
  const user = await findUserById(userId);
  if (!user || !user.IsActive || user.Role !== 'EMPLOYEE') {
    throw AppError.validation('User must be an active employee', {
      fields: [{ field: 'userId', message: 'must be an active employee' }],
    });
  }
  return user;
}

async function insertWithoutOverlap(leave: repo.NewLeave): Promise<number> {
  return withTransaction(async (tx) => {
    if (await repo.hasOverlappingLeave(leave.userId, leave.fromDate, leave.toDate, tx)) {
      throw refuse('fromDate', 'This leave overlaps an existing leave for the user');
    }
    return repo.insertLeave(leave, tx);
  });
}

async function requireLeaveDto(leaveId: number): Promise<LeaveDto> {
  const row = await repo.findLeave(leaveId);
  if (!row) throw AppError.notFound('Leave not found');
  return toLeaveDto(row);
}

/** Tells the dashboard about the change, and refreshes the employee's live row if the leave covers today. */
function announce(leave: LeaveDto): void {
  realtime.leaveChanged(leave);
  if (covers(leave, todayWorkDate())) realtime.attendanceChanged(leave.userId);
}

// ---- admin

export async function listLeaves(query: ListLeavesQuery): Promise<LeaveDto[]> {
  const rows = query.date
    ? await repo.listLeavesCovering(query.date)
    : await repo.listLeavesByStatus(query.status ?? 'APPROVED', todayWorkDate());
  return rows.map(toLeaveDto);
}

export async function recordLeave(adminId: number, input: CreateLeaveInput): Promise<LeaveDto> {
  await requireEmployee(input.userId);
  const id = await insertWithoutOverlap({
    ...input,
    createdBy: adminId,
    status: 'APPROVED',
    reviewedBy: adminId,
  });
  const leave = await requireLeaveDto(id);
  announce(leave);
  void pushService.notifyUsers([leave.userId], {
    title: 'Leave recorded',
    body: `${dateLabel(leave)}: ${leave.reason}`,
    data: { type: 'LEAVE', leaveId: String(leave.id) },
  });
  return leave;
}

/** Approves, rejects or cancels a leave as an admin. */
async function review(
  adminId: number,
  leaveId: number,
  to: 'APPROVED' | 'REJECTED' | 'CANCELLED',
  note: string | null,
): Promise<LeaveDto> {
  await withTransaction(async (tx) => {
    const row = await repo.findLeaveForUpdate(leaveId, tx);
    if (!row) throw AppError.notFound('Leave not found');
    if (to === 'CANCELLED') {
      if (row.Status !== 'PENDING' && row.Status !== 'APPROVED') {
        throw refuse('status', 'Only pending or approved leave can be cancelled');
      }
      if (fromDateColumn(row.ToDate) < todayWorkDate())
        throw refuse('status', 'Leave that has ended cannot be cancelled');
    } else if (row.Status !== 'PENDING') {
      throw refuse('status', 'Only pending leave requests can be approved or rejected');
    }
    await repo.setLeaveStatus(leaveId, { status: to, reviewedBy: adminId, note }, tx);
  });
  const leave = await requireLeaveDto(leaveId);
  announce(leave);
  const title = {
    APPROVED: 'Leave approved',
    REJECTED: 'Leave request rejected',
    CANCELLED: 'Leave cancelled',
  }[to];
  void pushService.notifyUsers([leave.userId], {
    title,
    body: note ? `${dateLabel(leave)}: ${note}` : dateLabel(leave),
    data: { type: 'LEAVE', leaveId: String(leave.id) },
  });
  return leave;
}

export const approveLeave = (adminId: number, leaveId: number, note?: string) =>
  review(adminId, leaveId, 'APPROVED', note ?? null);

export const rejectLeave = (adminId: number, leaveId: number, note?: string) =>
  review(adminId, leaveId, 'REJECTED', note ?? null);

export const cancelLeave = (adminId: number, leaveId: number, note?: string) =>
  review(adminId, leaveId, 'CANCELLED', note ?? null);

// ---- employee

export async function listMyLeaves(userId: number): Promise<LeaveDto[]> {
  return (await repo.listLeavesForUser(userId)).map(toLeaveDto);
}

export async function requestLeave(userId: number, input: RequestLeaveInput): Promise<LeaveDto> {
  if (input.fromDate < todayWorkDate()) throw refuse('fromDate', 'Leave cannot start in the past');
  const id = await insertWithoutOverlap({
    ...input,
    userId,
    createdBy: userId,
    status: 'PENDING',
    reviewedBy: null,
  });
  const leave = await requireLeaveDto(id);
  realtime.leaveChanged(leave);
  void pushService.notifyAllActive(
    {
      title: 'Leave request',
      body: `${leave.user.name}: ${dateLabel(leave)} (${leave.reason})`,
      data: { type: 'LEAVE_REQUEST', leaveId: String(leave.id) },
    },
    ADMIN_ROLES,
  );
  return leave;
}

/** Withdraws the employee's own pending leave, or approved leave that hasn't started yet. */
export async function withdrawLeave(userId: number, leaveId: number): Promise<LeaveDto> {
  const wasApproved = await withTransaction(async (tx) => {
    const row = await repo.findLeaveForUpdate(leaveId, tx);
    if (!row || row.UserId !== userId) throw AppError.notFound('Leave not found');
    const started = fromDateColumn(row.FromDate) <= todayWorkDate();
    if (row.Status === 'APPROVED' && started) {
      throw refuse('status', 'Approved leave that has started can only be cancelled by an admin');
    }
    if (row.Status !== 'PENDING' && row.Status !== 'APPROVED') {
      throw refuse('status', 'Only pending or approved leave can be withdrawn');
    }
    await repo.setLeaveStatus(leaveId, { status: 'CANCELLED', reviewedBy: userId, note: null }, tx);
    return row.Status === 'APPROVED';
  });
  const leave = await requireLeaveDto(leaveId);
  realtime.leaveChanged(leave);
  if (wasApproved) {
    void pushService.notifyAllActive(
      {
        title: 'Leave withdrawn',
        body: `${leave.user.name}: ${dateLabel(leave)}`,
        data: { type: 'LEAVE_REQUEST', leaveId: String(leave.id) },
      },
      ADMIN_ROLES,
    );
  }
  return leave;
}

/** Approved leave of the user overlapping [from, to] (the attendance history month). */
export async function approvedLeavesInRange(userId: number, from: string, to: string): Promise<LeaveDto[]> {
  return (await repo.listApprovedLeavesInRange(userId, from, to)).map(toLeaveDto);
}
