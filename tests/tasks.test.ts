import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { closePool } from '../src/db/pool';
import { pushService } from '../src/services/push.service';
import { addDaysToWorkDate, combineWorkDateAndTime, todayWorkDate } from '../src/utils/time';
import { app, auth, createOffice, createTask, createUser, resetDb, scalar, type TestUser } from './helpers';

let officeId: number;
let admin: TestUser;
let mark: TestUser;
let john: TestUser;
const today = todayWorkDate();

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x20), Buffer.from('\n%%EOF')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

beforeEach(async () => {
  await resetDb();
  officeId = await createOffice();
  admin = await createUser(officeId, { role: 'ADMIN', name: 'Admin' });
  mark = await createUser(officeId, { name: 'Mark Tan' });
  john = await createUser(officeId, { name: 'John Lim' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

const task = (opts: Partial<Parameters<typeof createTask>[0]> = {}) =>
  createTask({ assigneeId: mark.id, createdBy: admin.id, dueDate: today, ...opts });

describe('GET /tasks?date=', () => {
  it('returns own tasks for the date: IN_PROGRESS, then TODO/CARRIED_OVER by due time, then COMPLETED', async () => {
    await task({ title: 'done', status: 'COMPLETED', dueTime: '08:00' });
    await task({ title: 'late todo', dueTime: '16:00' });
    await task({ title: 'carried', status: 'CARRIED_OVER', dueTime: '10:00' });
    await task({ title: 'early todo', dueTime: '09:00' });
    await task({ title: 'doing', status: 'IN_PROGRESS', dueTime: '17:00' });
    await task({ title: 'tomorrow', dueDate: addDaysToWorkDate(today, 1) });
    await createTask({ assigneeId: john.id, createdBy: admin.id, dueDate: today, title: 'johns' });

    const res = await request(app).get(`/api/v1/tasks?date=${today}`).set(auth(mark));
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe(today);
    expect(res.body.data.total).toBe(5);
    expect(res.body.data.completed).toBe(1);
    expect(res.body.data.items.map((t: { title: string }) => t.title)).toEqual([
      'doing',
      'early todo',
      'carried',
      'late todo',
      'done',
    ]);
  });

  it('defaults to today and validates the date', async () => {
    await task();
    const res = await request(app).get('/api/v1/tasks').set(auth(mark));
    expect(res.body.data).toMatchObject({ date: today, total: 1 });
    expect((await request(app).get('/api/v1/tasks?date=2026-02-30').set(auth(mark))).status).toBe(400);
  });
});

describe('GET /tasks/:id', () => {
  it('returns the task detail to its assignee', async () => {
    const id = await task({ title: 'Client follow-up: SIA Engineering', priority: 'HIGH', dueTime: '11:00' });
    const res = await request(app).get(`/api/v1/tasks/${id}`).set(auth(mark));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id,
      title: 'Client follow-up: SIA Engineering',
      priority: 'HIGH',
      status: 'TODO',
      dueUtc: combineWorkDateAndTime(today, '11:00').toISOString().replace('.000Z', 'Z'),
      attachmentCount: 0,
      description: 'Test task',
      assignee: { id: mark.id, name: 'Mark Tan', initials: 'MT' },
      createdBy: { id: admin.id, name: 'Admin' },
      completedUtc: null,
      attachments: [],
    });
  });

  it('forbids other employees, allows admins, and 404s for missing tasks', async () => {
    const id = await task();
    expect((await request(app).get(`/api/v1/tasks/${id}`).set(auth(john))).body.error.code).toBe('FORBIDDEN');
    expect((await request(app).get(`/api/v1/tasks/${id}`).set(auth(admin))).status).toBe(200);
    const missing = await request(app).get('/api/v1/tasks/999999').set(auth(mark));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get('/api/v1/tasks/abc').set(auth(mark))).status).toBe(400);
  });
});

describe('PATCH /tasks/:id/status', () => {
  const patch = (user: TestUser, id: number, status: string) =>
    request(app).patch(`/api/v1/tasks/${id}/status`).set(auth(user)).send({ status });

  it('moves TODO → IN_PROGRESS → COMPLETED and sets completedUtc', async () => {
    const id = await task();
    const started = await patch(mark, id, 'IN_PROGRESS');
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({ status: 'IN_PROGRESS', completedUtc: null });

    const done = await patch(mark, id, 'COMPLETED');
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('COMPLETED');
    expect(done.body.data.completedUtc).toMatch(/Z$/);
  });

  it('treats CARRIED_OVER like TODO', async () => {
    const id = await task({ status: 'CARRIED_OVER' });
    expect((await patch(mark, id, 'IN_PROGRESS')).body.data.status).toBe('IN_PROGRESS');
  });

  it('rejects skipping or reversing steps', async () => {
    const todo = await task();
    const skip = await patch(mark, todo, 'COMPLETED');
    expect(skip.status).toBe(400);
    expect(skip.body.error.code).toBe('VALIDATION_ERROR');

    const done = await task({ status: 'COMPLETED' });
    expect((await patch(mark, done, 'IN_PROGRESS')).status).toBe(400);
    expect((await patch(mark, todo, 'TODO')).status).toBe(400);
  });

  it('only lets the assignee change status', async () => {
    const id = await task();
    expect((await patch(john, id, 'IN_PROGRESS')).body.error.code).toBe('FORBIDDEN');
    expect((await patch(admin, id, 'IN_PROGRESS')).status).toBe(403);
  });
});

describe('attachments', () => {
  const upload = (user: TestUser, id: number, data: Buffer, filename: string, contentType: string) =>
    request(app)
      .post(`/api/v1/tasks/${id}/attachments`)
      .set(auth(user))
      .attach('file', data, { filename, contentType });

  it('uploads a report and serves it only to the owner and admins', async () => {
    const id = await task();
    const res = await upload(mark, id, PDF, 'UT report.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      fileName: 'UT report.pdf',
      url: `${env.PUBLIC_BASE_URL}/api/v1/files/${res.body.data.id}`,
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
      uploadedUtc: expect.stringMatching(/Z$/),
    });

    // Stored under a random name, not the client's.
    const stored = await scalar<string>('SELECT StoredPath FROM dbo.TaskAttachments');
    expect(stored).not.toContain('UT report');
    expect(fs.existsSync(path.resolve(env.UPLOAD_DIR, stored))).toBe(true);

    const detail = await request(app).get(`/api/v1/tasks/${id}`).set(auth(mark));
    expect(detail.body.data.attachmentCount).toBe(1);
    expect(detail.body.data.attachments[0].fileName).toBe('UT report.pdf');

    const fileId = res.body.data.id;
    const download = await request(app)
      .get(`/api/v1/files/${fileId}`)
      .set(auth(mark))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(download.body as Buffer, PDF)).toBe(0);

    expect((await request(app).get(`/api/v1/files/${fileId}`).set(auth(admin))).status).toBe(200);
    expect((await request(app).get(`/api/v1/files/${fileId}`).set(auth(john))).status).toBe(403);
    expect((await request(app).get(`/api/v1/files/${fileId}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/files/999999').set(auth(mark))).status).toBe(404);
  });

  it('is not exposed as a public static folder', async () => {
    const id = await task();
    await upload(mark, id, PNG, 'photo.png', 'image/png');
    const stored = await scalar<string>('SELECT StoredPath FROM dbo.TaskAttachments');
    expect((await request(app).get(`/uploads/${stored}`)).status).toBe(404);
    expect((await request(app).get(`/${stored}`)).status).toBe(404);
  });

  it('rejects disallowed types and spoofed content', async () => {
    const id = await task();
    const exe = await upload(mark, id, Buffer.from('MZ....'), 'tool.exe', 'application/octet-stream');
    expect(exe.status).toBe(400);
    expect(exe.body.error.code).toBe('VALIDATION_ERROR');

    const spoofed = await upload(
      mark,
      id,
      Buffer.from('<script>alert(1)</script>'),
      'report.pdf',
      'application/pdf',
    );
    expect(spoofed.status).toBe(400);

    const mismatched = await upload(mark, id, PDF, 'report.pdf', 'image/png');
    expect(mismatched.status).toBe(400);
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.TaskAttachments')).toBe(0);
  });

  it('enforces the size limit', async () => {
    const id = await task();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(env.MAX_UPLOAD_MB * 1024 * 1024)]);
    const res = await upload(mark, id, big, 'big.pdf', 'application/pdf');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/too large/i);
  });

  it('requires a file and forbids uploads to other people’s tasks', async () => {
    const id = await task();
    const none = await request(app).post(`/api/v1/tasks/${id}/attachments`).set(auth(mark)).field('x', '1');
    expect(none.status).toBe(400);
    const others = await upload(john, id, PDF, 'r.pdf', 'application/pdf');
    expect(others.status).toBe(403);
  });
});

describe('admin tasks', () => {
  const create = (body: object, user: TestUser = admin) =>
    request(app)
      .post('/api/v1/admin/tasks')
      .set(auth(user))
      .send({
        title: 'Eddy current inspection: B737 wheel hub',
        description: 'Per NTM-114',
        assigneeId: mark.id,
        priority: 'HIGH',
        dueDate: today,
        dueTime: '14:30',
        notify: false,
        ...body,
      });

  it('creates a task with the due time interpreted in SG time', async () => {
    const res = await create({});
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'Eddy current inspection: B737 wheel hub',
      status: 'TODO',
      priority: 'HIGH',
      dueUtc: combineWorkDateAndTime(today, '14:30').toISOString().replace('.000Z', 'Z'),
      assignee: { id: mark.id, name: 'Mark Tan', initials: 'MT' },
      createdBy: { id: admin.id, name: 'Admin' },
    });
    const mine = await request(app).get('/api/v1/tasks').set(auth(mark));
    expect(mine.body.data.total).toBe(1);
  });

  it('notifies the assignee only when notify=true', async () => {
    const spy = vi.spyOn(pushService, 'notifyUsers').mockResolvedValue();
    await create({ notify: false });
    expect(spy).not.toHaveBeenCalled();
    const res = await create({ notify: true });
    expect(spy).toHaveBeenCalledWith([mark.id], expect.objectContaining({ title: 'New task assigned' }));
    expect(spy.mock.calls[0]![1].data).toEqual({ type: 'TASK', taskId: String(res.body.data.id) });
  });

  it('validates input and the assignee', async () => {
    expect((await create({ assigneeId: admin.id })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await create({ assigneeId: 999999 })).status).toBe(400);
    expect((await create({ priority: 'URGENT' })).status).toBe(400);
    expect((await create({ dueTime: '25:00' })).status).toBe(400);
    expect((await create({ title: '' })).status).toBe(400);
  });

  it('is admin only', async () => {
    const res = await create({}, mark);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await request(app).get('/api/v1/admin/tasks')).status).toBe(401);
  });

  it('lists with filters and pagination, and reports stats', async () => {
    for (let i = 0; i < 3; i++) await task({ title: `mark ${i}` });
    await task({ status: 'COMPLETED' });
    await task({ status: 'CARRIED_OVER' });
    await createTask({ assigneeId: john.id, createdBy: admin.id, dueDate: today, status: 'IN_PROGRESS' });

    const page1 = await request(app).get('/api/v1/admin/tasks?pageSize=2&page=1').set(auth(admin));
    expect(page1.status).toBe(200);
    expect(page1.body.data).toMatchObject({ page: 1, pageSize: 2, total: 6 });
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.items[0]).toEqual({
      id: expect.any(Number),
      title: expect.any(String),
      priority: expect.any(String),
      status: expect.any(String),
      dueUtc: expect.any(String),
      attachmentCount: 0,
      assignee: { id: expect.any(Number), name: expect.any(String), initials: expect.any(String) },
    });

    const johns = await request(app).get(`/api/v1/admin/tasks?assigneeId=${john.id}`).set(auth(admin));
    expect(johns.body.data.total).toBe(1);
    const completed = await request(app).get('/api/v1/admin/tasks?status=COMPLETED').set(auth(admin));
    expect(completed.body.data.total).toBe(1);

    const stats = await request(app).get('/api/v1/admin/tasks/stats').set(auth(admin));
    expect(stats.body.data).toEqual({ pending: 5, completed: 1 });
  });

  it('patches individual fields, keeping the other half of the due date/time', async () => {
    const id = (await create({})).body.data.id;
    const res = await request(app)
      .patch(`/api/v1/admin/tasks/${id}`)
      .set(auth(admin))
      .send({ dueTime: '16:00', priority: 'LOW' });
    expect(res.status).toBe(200);
    expect(res.body.data.priority).toBe('LOW');
    expect(res.body.data.dueUtc).toBe(
      combineWorkDateAndTime(today, '16:00').toISOString().replace('.000Z', 'Z'),
    );

    const tomorrow = addDaysToWorkDate(today, 1);
    const moved = await request(app)
      .patch(`/api/v1/admin/tasks/${id}`)
      .set(auth(admin))
      .send({ dueDate: tomorrow, assigneeId: john.id });
    expect(moved.body.data.dueUtc).toBe(
      combineWorkDateAndTime(tomorrow, '16:00').toISOString().replace('.000Z', 'Z'),
    );
    expect(moved.body.data.assignee.id).toBe(john.id);

    expect((await request(app).patch(`/api/v1/admin/tasks/${id}`).set(auth(admin)).send({})).status).toBe(
      400,
    );
    expect(
      (await request(app).patch('/api/v1/admin/tasks/999999').set(auth(admin)).send({ title: 'x' })).status,
    ).toBe(404);
  });

  it('deletes a task with its attachments', async () => {
    const id = await task();
    await request(app)
      .post(`/api/v1/tasks/${id}/attachments`)
      .set(auth(mark))
      .attach('file', PDF, { filename: 'r.pdf', contentType: 'application/pdf' });
    const stored = await scalar<string>('SELECT StoredPath FROM dbo.TaskAttachments');

    const res = await request(app).delete(`/api/v1/admin/tasks/${id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: {} });
    expect((await request(app).get(`/api/v1/tasks/${id}`).set(auth(admin))).status).toBe(404);
    expect(fs.existsSync(path.resolve(env.UPLOAD_DIR, stored))).toBe(false);
    expect((await request(app).delete(`/api/v1/admin/tasks/${id}`).set(auth(admin))).status).toBe(404);
  });
});
