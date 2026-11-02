import { bindIntList, createRequest, dateParam, sql, type Queryable } from '../../db/pool';
import type { Priority, TaskStatus } from './tasks.types';

export interface TaskRow {
  TaskId: number;
  Title: string;
  Description: string;
  AssigneeId: number;
  AssigneeName: string;
  CreatedBy: number;
  CreatedByName: string;
  Priority: Priority;
  Status: TaskStatus;
  DueUtc: Date;
  DueWorkDate: Date;
  CompletedUtc: Date | null;
  AttachmentCount: number;
}

export interface AttachmentRow {
  AttachmentId: number;
  TaskId: number;
  FileName: string;
  StoredPath: string;
  MimeType: string;
  SizeBytes: number;
  UploadedBy: number;
  UploadedUtc: Date;
}

const TASK_SELECT = `
  SELECT t.TaskId, t.Title, t.Description, t.AssigneeId, a.Name AS AssigneeName,
         t.CreatedBy, c.Name AS CreatedByName, t.Priority, t.Status, t.DueUtc, t.DueWorkDate, t.CompletedUtc,
         (SELECT COUNT(*) FROM dbo.TaskAttachments ta WHERE ta.TaskId = t.TaskId) AS AttachmentCount
    FROM dbo.Tasks t
    JOIN dbo.Users a ON a.UserId = t.AssigneeId
    JOIN dbo.Users c ON c.UserId = t.CreatedBy`;

/** IN_PROGRESS first, then TODO / CARRIED_OVER by due time, then COMPLETED. */
const DAY_ORDER = `
  ORDER BY CASE t.Status WHEN N'IN_PROGRESS' THEN 0 WHEN N'COMPLETED' THEN 2 ELSE 1 END, t.DueUtc, t.TaskId`;

export async function listTasksForAssigneeOnDate(
  assigneeId: number,
  workDate: string,
  db?: Queryable,
): Promise<TaskRow[]> {
  const request = await createRequest(db);
  const result = await request
    .input('assigneeId', sql.Int, assigneeId)
    .input('date', sql.Date, dateParam(workDate))
    .query<TaskRow>(`${TASK_SELECT} WHERE t.AssigneeId = @assigneeId AND t.DueWorkDate = @date ${DAY_ORDER}`);
  return result.recordset;
}

export async function findTaskById(taskId: number, db?: Queryable): Promise<TaskRow | null> {
  const request = await createRequest(db);
  const result = await request
    .input('taskId', sql.Int, taskId)
    .query<TaskRow>(`${TASK_SELECT} WHERE t.TaskId = @taskId`);
  return result.recordset[0] ?? null;
}

/** Locks the given tasks (UPDLOCK) for the rest of the transaction. */
export async function lockTasksByIds(
  taskIds: number[],
  db: Queryable,
): Promise<Pick<TaskRow, 'TaskId' | 'AssigneeId' | 'Status' | 'DueUtc' | 'DueWorkDate'>[]> {
  if (taskIds.length === 0) return [];
  const request = await createRequest(db);
  const list = bindIntList(request, 'id', taskIds);
  const result = await request.query<
    Pick<TaskRow, 'TaskId' | 'AssigneeId' | 'Status' | 'DueUtc' | 'DueWorkDate'>
  >(
    `SELECT TaskId, AssigneeId, Status, DueUtc, DueWorkDate
       FROM dbo.Tasks WITH (UPDLOCK, ROWLOCK)
      WHERE TaskId IN (${list})`,
  );
  return result.recordset;
}

export async function updateTaskStatus(
  taskId: number,
  status: TaskStatus,
  completedUtc: Date | null,
  db?: Queryable,
): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('taskId', sql.Int, taskId)
    .input('status', sql.NVarChar(20), status)
    .input('completedUtc', sql.DateTime2(0), completedUtc)
    .query(
      `UPDATE dbo.Tasks SET Status = @status, CompletedUtc = @completedUtc, UpdatedUtc = SYSUTCDATETIME()
       WHERE TaskId = @taskId`,
    );
}

/** Conditional status change; returns false if the task was no longer in `fromStatus` (concurrent update). */
export async function transitionTaskStatus(
  taskId: number,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  completedUtc: Date | null,
): Promise<boolean> {
  const request = await createRequest();
  const result = await request
    .input('taskId', sql.Int, taskId)
    .input('from', sql.NVarChar(20), fromStatus)
    .input('to', sql.NVarChar(20), toStatus)
    .input('completedUtc', sql.DateTime2(0), completedUtc)
    .query(
      `UPDATE dbo.Tasks SET Status = @to, CompletedUtc = @completedUtc, UpdatedUtc = SYSUTCDATETIME()
       WHERE TaskId = @taskId AND Status = @from`,
    );
  return result.rowsAffected[0] === 1;
}

export async function carryOverTask(
  taskId: number,
  dueUtc: Date,
  dueWorkDate: string,
  db: Queryable,
): Promise<void> {
  const request = await createRequest(db);
  await request
    .input('taskId', sql.Int, taskId)
    .input('dueUtc', sql.DateTime2(0), dueUtc)
    .input('dueWorkDate', sql.Date, dateParam(dueWorkDate))
    .query(
      `UPDATE dbo.Tasks
          SET Status = N'CARRIED_OVER', DueUtc = @dueUtc, DueWorkDate = @dueWorkDate, UpdatedUtc = SYSUTCDATETIME()
        WHERE TaskId = @taskId`,
    );
}

export interface NewTask {
  title: string;
  description: string;
  assigneeId: number;
  createdBy: number;
  priority: Priority;
  dueUtc: Date;
  dueWorkDate: string;
}

export async function insertTask(task: NewTask): Promise<number> {
  const request = await createRequest();
  const result = await request
    .input('title', sql.NVarChar(200), task.title)
    .input('description', sql.NVarChar(4000), task.description)
    .input('assigneeId', sql.Int, task.assigneeId)
    .input('createdBy', sql.Int, task.createdBy)
    .input('priority', sql.NVarChar(10), task.priority)
    .input('dueUtc', sql.DateTime2(0), task.dueUtc)
    .input('dueWorkDate', sql.Date, dateParam(task.dueWorkDate))
    .query<{ TaskId: number }>(
      `INSERT INTO dbo.Tasks (Title, Description, AssigneeId, CreatedBy, Priority, DueUtc, DueWorkDate)
       OUTPUT INSERTED.TaskId
       VALUES (@title, @description, @assigneeId, @createdBy, @priority, @dueUtc, @dueWorkDate)`,
    );
  return result.recordset[0]!.TaskId;
}

export type TaskUpdate = Partial<Omit<NewTask, 'createdBy'>>;

export async function updateTask(taskId: number, changes: TaskUpdate): Promise<void> {
  const request = await createRequest();
  const sets: string[] = [];
  const set = (column: string, param: string, type: sql.ISqlType | (() => sql.ISqlType), value: unknown) => {
    request.input(param, type, value);
    sets.push(`${column} = @${param}`);
  };
  if (changes.title !== undefined) set('Title', 'title', sql.NVarChar(200), changes.title);
  if (changes.description !== undefined)
    set('Description', 'description', sql.NVarChar(4000), changes.description);
  if (changes.assigneeId !== undefined) set('AssigneeId', 'assigneeId', sql.Int, changes.assigneeId);
  if (changes.priority !== undefined) set('Priority', 'priority', sql.NVarChar(10), changes.priority);
  if (changes.dueUtc !== undefined) set('DueUtc', 'dueUtc', sql.DateTime2(0), changes.dueUtc);
  if (changes.dueWorkDate !== undefined)
    set('DueWorkDate', 'dueWorkDate', sql.Date, dateParam(changes.dueWorkDate));
  if (sets.length === 0) return;
  request.input('taskId', sql.Int, taskId);
  await request.query(
    `UPDATE dbo.Tasks SET ${sets.join(', ')}, UpdatedUtc = SYSUTCDATETIME() WHERE TaskId = @taskId`,
  );
}

/** Deletes a task and its attachment rows; returns the stored paths of the removed files. */
export async function deleteTask(taskId: number, db: Queryable): Promise<string[]> {
  const request = await createRequest(db);
  const result = await request.input('taskId', sql.Int, taskId).query<{ StoredPath: string }>(
    `DELETE FROM dbo.TaskAttachments OUTPUT DELETED.StoredPath WHERE TaskId = @taskId;
     DELETE FROM dbo.Tasks WHERE TaskId = @taskId;`,
  );
  return result.recordset.map((r) => r.StoredPath);
}

export interface AdminTaskFilter {
  status?: TaskStatus;
  assigneeId?: number;
  date?: string;
}

export async function listTasksForAdmin(
  filter: AdminTaskFilter,
  page: number,
  pageSize: number,
): Promise<{ rows: TaskRow[]; total: number }> {
  const request = await createRequest();
  request
    .input('status', sql.NVarChar(20), filter.status ?? null)
    .input('assigneeId', sql.Int, filter.assigneeId ?? null)
    .input('date', sql.Date, filter.date ? dateParam(filter.date) : null)
    .input('offset', sql.Int, (page - 1) * pageSize)
    .input('pageSize', sql.Int, pageSize);
  const where = `WHERE (@status IS NULL OR t.Status = @status)
                   AND (@assigneeId IS NULL OR t.AssigneeId = @assigneeId)
                   AND (@date IS NULL OR t.DueWorkDate = @date)`;
  const result = await request.query(
    `SELECT COUNT(*) AS Total FROM dbo.Tasks t ${where};
     ${TASK_SELECT} ${where}
     ORDER BY t.DueUtc DESC, t.TaskId DESC
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;`,
  );
  const recordsets = result.recordsets as unknown as [[{ Total: number }], TaskRow[]];
  return { total: recordsets[0][0].Total, rows: recordsets[1] };
}

export async function taskStats(): Promise<{ pending: number; completed: number }> {
  const request = await createRequest();
  const result = await request.query<{ pending: number; completed: number }>(
    `SELECT ISNULL(SUM(CASE WHEN Status <> N'COMPLETED' THEN 1 ELSE 0 END), 0) AS pending,
            ISNULL(SUM(CASE WHEN Status = N'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed
       FROM dbo.Tasks`,
  );
  return result.recordset[0]!;
}

/** Completed / total tasks due on a work date, optionally for one assignee. */
export async function taskCountsOnDate(
  workDate: string,
  assigneeId?: number,
): Promise<{ total: number; completed: number }> {
  const request = await createRequest();
  const result = await request
    .input('date', sql.Date, dateParam(workDate))
    .input('assigneeId', sql.Int, assigneeId ?? null)
    .query<{ total: number; completed: number }>(
      `SELECT COUNT(*) AS total, ISNULL(SUM(CASE WHEN Status = N'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed
         FROM dbo.Tasks
        WHERE DueWorkDate = @date AND (@assigneeId IS NULL OR AssigneeId = @assigneeId)`,
    );
  return result.recordset[0]!;
}

/** Completed / total tasks due in a date range for one assignee. */
export async function taskCountsInRange(
  assigneeId: number,
  from: string,
  to: string,
): Promise<{ total: number; completed: number }> {
  const request = await createRequest();
  const result = await request
    .input('assigneeId', sql.Int, assigneeId)
    .input('from', sql.Date, dateParam(from))
    .input('to', sql.Date, dateParam(to))
    .query<{ total: number; completed: number }>(
      `SELECT COUNT(*) AS total, ISNULL(SUM(CASE WHEN Status = N'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed
         FROM dbo.Tasks
        WHERE AssigneeId = @assigneeId AND DueWorkDate BETWEEN @from AND @to`,
    );
  return result.recordset[0]!;
}

export async function listAttachments(taskId: number): Promise<AttachmentRow[]> {
  const request = await createRequest();
  const result = await request.input('taskId', sql.Int, taskId).query<AttachmentRow>(
    `SELECT AttachmentId, TaskId, FileName, StoredPath, MimeType, SizeBytes, UploadedBy, UploadedUtc
       FROM dbo.TaskAttachments WHERE TaskId = @taskId ORDER BY UploadedUtc, AttachmentId`,
  );
  return result.recordset;
}

export async function insertAttachment(a: Omit<AttachmentRow, 'AttachmentId'>): Promise<AttachmentRow> {
  const request = await createRequest();
  const result = await request
    .input('taskId', sql.Int, a.TaskId)
    .input('fileName', sql.NVarChar(255), a.FileName)
    .input('storedPath', sql.NVarChar(500), a.StoredPath)
    .input('mimeType', sql.NVarChar(150), a.MimeType)
    .input('sizeBytes', sql.BigInt, a.SizeBytes)
    .input('uploadedBy', sql.Int, a.UploadedBy)
    .input('uploadedUtc', sql.DateTime2(0), a.UploadedUtc)
    .query<AttachmentRow>(
      `INSERT INTO dbo.TaskAttachments (TaskId, FileName, StoredPath, MimeType, SizeBytes, UploadedBy, UploadedUtc)
       OUTPUT INSERTED.AttachmentId, INSERTED.TaskId, INSERTED.FileName, INSERTED.StoredPath, INSERTED.MimeType,
              INSERTED.SizeBytes, INSERTED.UploadedBy, INSERTED.UploadedUtc
       VALUES (@taskId, @fileName, @storedPath, @mimeType, @sizeBytes, @uploadedBy, @uploadedUtc)`,
    );
  return result.recordset[0]!;
}

export async function findAttachmentWithOwner(
  attachmentId: number,
): Promise<(AttachmentRow & { AssigneeId: number }) | null> {
  const request = await createRequest();
  const result = await request
    .input('id', sql.Int, attachmentId)
    .query<AttachmentRow & { AssigneeId: number }>(
      `SELECT ta.AttachmentId, ta.TaskId, ta.FileName, ta.StoredPath, ta.MimeType, ta.SizeBytes, ta.UploadedBy,
            ta.UploadedUtc, t.AssigneeId
       FROM dbo.TaskAttachments ta JOIN dbo.Tasks t ON t.TaskId = ta.TaskId
      WHERE ta.AttachmentId = @id`,
    );
  return result.recordset[0] ?? null;
}
