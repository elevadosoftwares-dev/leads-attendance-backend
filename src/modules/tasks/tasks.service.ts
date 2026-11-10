import fs from 'node:fs';
import path from 'node:path';
import { fromDateColumn, withTransaction } from '../../db/pool';
import { safeFileName } from '../../middleware/upload';
import { pushService } from '../../services/push.service';
import { realtime } from '../../services/realtime.service';
import { storage } from '../../services/storage.service';
import { AppError } from '../../utils/AppError';
import type { Paginated } from '../../utils/apiResponse';
import { logger } from '../../utils/logger';
import { combineWorkDateAndTime, nowUtc, toLocalTime, todayWorkDate } from '../../utils/time';
import { isAdminRole, type AuthUser } from '../auth/auth.types';
import { findUserById } from '../users/users.repository';
import { toAttachmentDto, toTaskDetail, toTaskSummary, toTaskSummaryWithAssignee } from './tasks.mapper';
import * as repo from './tasks.repository';
import type { CreateTaskInput, UpdateTaskInput } from './tasks.schemas';
import type {
  AttachmentDto,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  TaskSummaryWithAssignee,
} from './tasks.types';

/** Allowed employee status moves. CARRIED_OVER behaves like TODO on its new date. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  TODO: ['IN_PROGRESS'],
  CARRIED_OVER: ['IN_PROGRESS'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
};

async function loadTask(taskId: number): Promise<repo.TaskRow> {
  const task = await repo.findTaskById(taskId);
  if (!task) throw AppError.notFound('Task not found');
  return task;
}

/** Admins can see any task; employees only their own. */
function assertCanView(user: AuthUser, task: repo.TaskRow): void {
  if (!isAdminRole(user.role) && task.AssigneeId !== user.id) {
    throw AppError.forbidden('You can only access your own tasks');
  }
}

async function detail(taskId: number): Promise<TaskDetail> {
  const [task, attachments] = await Promise.all([loadTask(taskId), repo.listAttachments(taskId)]);
  return toTaskDetail(task, attachments);
}

function emitTaskChanged(row: repo.TaskRow | null): void {
  if (row) realtime.tasksChanged([toTaskSummaryWithAssignee(row)]);
}

export async function listForDate(
  userId: number,
  date: string = todayWorkDate(),
): Promise<{ date: string; completed: number; total: number; items: TaskSummary[] }> {
  const rows = await repo.listTasksForAssigneeOnDate(userId, date);
  return {
    date,
    completed: rows.filter((r) => r.Status === 'COMPLETED').length,
    total: rows.length,
    items: rows.map(toTaskSummary),
  };
}

export async function getTask(user: AuthUser, taskId: number): Promise<TaskDetail> {
  const task = await loadTask(taskId);
  assertCanView(user, task);
  return detail(taskId);
}

/** Throws NOT_FOUND / FORBIDDEN unless the employee owns the task. */
export async function assertOwnTask(user: AuthUser, taskId: number): Promise<repo.TaskRow> {
  const task = await loadTask(taskId);
  if (task.AssigneeId !== user.id) throw AppError.forbidden('You can only modify your own tasks');
  return task;
}

export async function updateStatus(user: AuthUser, taskId: number, status: TaskStatus): Promise<TaskDetail> {
  const task = await assertOwnTask(user, taskId);
  if (!TRANSITIONS[task.Status].includes(status)) {
    throw AppError.validation(`A ${task.Status} task cannot be moved to ${status}`, {
      fields: [
        {
          field: 'status',
          message: `allowed from ${task.Status}: ${TRANSITIONS[task.Status].join(', ') || 'none'}`,
        },
      ],
      currentStatus: task.Status,
    });
  }
  const completedUtc = status === 'COMPLETED' ? nowUtc() : null;
  const changed = await repo.transitionTaskStatus(taskId, task.Status, status, completedUtc);
  if (!changed) {
    throw AppError.validation('The task was changed by someone else; reload and try again', {
      fields: [{ field: 'status', message: 'stale status' }],
    });
  }
  emitTaskChanged(await repo.findTaskById(taskId));
  return detail(taskId);
}

export async function addAttachment(
  user: AuthUser,
  taskId: number,
  file: Express.Multer.File,
): Promise<AttachmentDto> {
  try {
    await assertOwnTask(user, taskId);
    const key = await storage.saveFromTemp(file.path, path.extname(file.originalname));
    try {
      const row = await repo.insertAttachment({
        TaskId: taskId,
        FileName: safeFileName(file.originalname),
        StoredPath: key,
        MimeType: file.mimetype.toLowerCase() === 'image/jpg' ? 'image/jpeg' : file.mimetype.toLowerCase(),
        SizeBytes: file.size,
        UploadedBy: user.id,
        UploadedUtc: nowUtc(),
      });
      emitTaskChanged(await repo.findTaskById(taskId));
      return toAttachmentDto(row);
    } catch (err) {
      await storage.remove(key).catch(() => undefined);
      throw err;
    }
  } finally {
    // No-op once the temp file has been moved into storage.
    await fs.promises.rm(file.path, { force: true }).catch(() => undefined);
  }
}

export async function openAttachment(user: AuthUser, attachmentId: number) {
  const attachment = await repo.findAttachmentWithOwner(attachmentId);
  if (!attachment) throw AppError.notFound('File not found');
  const allowed =
    isAdminRole(user.role) || attachment.AssigneeId === user.id || attachment.UploadedBy === user.id;
  if (!allowed) throw AppError.forbidden('You do not have access to this file');
  try {
    const { stream, size } = await storage.open(attachment.StoredPath);
    return { stream, size, fileName: attachment.FileName, mimeType: attachment.MimeType };
  } catch (err) {
    logger.error({ err, attachmentId }, 'Attachment missing from storage');
    throw AppError.notFound('File not found');
  }
}

// ---------- Admin ----------

async function assertAssignable(assigneeId: number): Promise<void> {
  const assignee = await findUserById(assigneeId);
  if (!assignee || !assignee.IsActive || assignee.Role !== 'EMPLOYEE') {
    throw AppError.validation('Assignee must be an active employee', {
      fields: [{ field: 'assigneeId', message: 'must be an active employee' }],
    });
  }
}

function notifyAssignee(assigneeId: number, taskId: number, title: string, heading: string): void {
  void pushService.notifyUsers([assigneeId], {
    title: heading,
    body: title,
    data: { type: 'TASK', taskId: String(taskId) },
  });
}

export async function createTask(adminId: number, input: CreateTaskInput): Promise<TaskDetail> {
  await assertAssignable(input.assigneeId);
  const taskId = await repo.insertTask({
    title: input.title,
    description: input.description,
    assigneeId: input.assigneeId,
    createdBy: adminId,
    priority: input.priority,
    dueUtc: combineWorkDateAndTime(input.dueDate, input.dueTime),
    dueWorkDate: input.dueDate,
  });
  // The assignee always hears about a new task; `notify` is accepted for older clients but ignored.
  notifyAssignee(input.assigneeId, taskId, input.title, 'New task assigned');
  emitTaskChanged(await repo.findTaskById(taskId));
  return detail(taskId);
}

export async function listForAdmin(
  filter: repo.AdminTaskFilter,
  page: number,
  pageSize: number,
): Promise<Paginated<TaskSummaryWithAssignee>> {
  const { rows, total } = await repo.listTasksForAdmin(filter, page, pageSize);
  return { items: rows.map(toTaskSummaryWithAssignee), page, pageSize, total };
}

export function stats(): Promise<{ pending: number; completed: number }> {
  return repo.taskStats();
}

export async function updateTask(taskId: number, input: UpdateTaskInput): Promise<TaskDetail> {
  const task = await loadTask(taskId);
  if (input.assigneeId !== undefined) await assertAssignable(input.assigneeId);

  const changes: repo.TaskUpdate = {
    title: input.title,
    description: input.description,
    assigneeId: input.assigneeId,
    priority: input.priority,
  };
  if (input.dueDate !== undefined || input.dueTime !== undefined) {
    // A partial change keeps the other half of the existing due date/time.
    const dueDate = input.dueDate ?? fromDateColumn(task.DueWorkDate);
    const dueTime = input.dueTime ?? toLocalTime(task.DueUtc);
    changes.dueUtc = combineWorkDateAndTime(dueDate, dueTime);
    changes.dueWorkDate = dueDate;
  }
  await repo.updateTask(taskId, changes);

  const updated = await detail(taskId);
  // A new assignee is always told; other edits push only with `notify: true`.
  const reassigned = input.assigneeId !== undefined && input.assigneeId !== task.AssigneeId;
  if (reassigned || input.notify) {
    notifyAssignee(
      updated.assignee.id,
      taskId,
      updated.title,
      reassigned ? 'New task assigned' : 'Task updated',
    );
  }
  emitTaskChanged(await repo.findTaskById(taskId));
  return updated;
}

export async function deleteTask(taskId: number): Promise<void> {
  const task = await loadTask(taskId);
  const keys = await withTransaction((tx) => repo.deleteTask(taskId, tx));
  await Promise.all(
    keys.map((key) =>
      storage
        .remove(key)
        .catch((err: unknown) => logger.warn({ err, key }, 'Failed to delete attachment file')),
    ),
  );
  realtime.tasksChanged([{ ...toTaskSummaryWithAssignee(task), deleted: true }]);
}
