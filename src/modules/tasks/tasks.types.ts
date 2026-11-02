export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'COMPLETED', 'CARRIED_OVER'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface TaskSummary {
  id: number;
  title: string;
  priority: Priority;
  status: TaskStatus;
  dueUtc: string;
  attachmentCount: number;
}

export interface AttachmentDto {
  id: number;
  fileName: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  uploadedUtc: string;
}

export interface TaskDetail extends TaskSummary {
  description: string;
  assignee: { id: number; name: string; initials: string };
  createdBy: { id: number; name: string };
  completedUtc: string | null;
  attachments: AttachmentDto[];
}

export interface TaskSummaryWithAssignee extends TaskSummary {
  assignee: { id: number; name: string; initials: string };
}
