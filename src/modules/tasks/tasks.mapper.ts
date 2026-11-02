import { env } from '../../config/env';
import { initialsOf } from '../../utils/format';
import { isoUtc } from '../../utils/time';
import type { AttachmentRow, TaskRow } from './tasks.repository';
import type { AttachmentDto, TaskDetail, TaskSummary, TaskSummaryWithAssignee } from './tasks.types';

export function toTaskSummary(row: TaskRow): TaskSummary {
  return {
    id: row.TaskId,
    title: row.Title,
    priority: row.Priority,
    status: row.Status,
    dueUtc: isoUtc(row.DueUtc),
    attachmentCount: row.AttachmentCount,
  };
}

export function toTaskSummaryWithAssignee(row: TaskRow): TaskSummaryWithAssignee {
  return {
    ...toTaskSummary(row),
    assignee: { id: row.AssigneeId, name: row.AssigneeName, initials: initialsOf(row.AssigneeName) },
  };
}

export function attachmentUrl(attachmentId: number): string {
  return `${env.PUBLIC_BASE_URL}/api/v1/files/${attachmentId}`;
}

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.AttachmentId,
    fileName: row.FileName,
    url: attachmentUrl(row.AttachmentId),
    mimeType: row.MimeType,
    sizeBytes: Number(row.SizeBytes),
    uploadedUtc: isoUtc(row.UploadedUtc),
  };
}

export function toTaskDetail(row: TaskRow, attachments: AttachmentRow[]): TaskDetail {
  return {
    ...toTaskSummaryWithAssignee(row),
    description: row.Description,
    createdBy: { id: row.CreatedBy, name: row.CreatedByName },
    completedUtc: isoUtc(row.CompletedUtc),
    attachments: attachments.map(toAttachmentDto),
  };
}
