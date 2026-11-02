import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { detachAdminNamespace } from '../src/services/realtime.service';
import { createSocketServer } from '../src/socket';
import { addDaysToWorkDate, combineWorkDateAndTime, todayWorkDate } from '../src/utils/time';
import {
  app,
  auth,
  createAttendance,
  createOffice,
  createTask,
  createUser,
  pointNorth,
  resetDb,
  scalar,
  type TestUser,
} from './helpers';

let officeId: number;
let admin: TestUser;
let mark: TestUser;
let john: TestUser;
let sarah: TestUser;
let david: TestUser;
let emma: TestUser;
const today = todayWorkDate();
const yesterday = addDaysToWorkDate(today, -1);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeEach(async () => {
  await resetDb();
  officeId = await createOffice();
  admin = await createUser(officeId, { role: 'ADMIN', name: 'Admin' });
  mark = await createUser(officeId, { name: 'Mark Tan' });
  john = await createUser(officeId, { name: 'John Lim' });
  sarah = await createUser(officeId, { name: 'Sarah Lee' });
  david = await createUser(officeId, { name: 'David Ng' });
  emma = await createUser(officeId, { name: 'Emma Koh' });
  await createUser(officeId, { name: 'Inactive Person', isActive: false });
});

afterAll(async () => {
  await closePool();
});

const addLeave = (user: TestUser, fromDate: string, toDate: string) =>
  request(app)
    .post('/api/v1/admin/leaves')
    .set(auth(admin))
    .send({ userId: user.id, fromDate, toDate, reason: 'Annual leave' });

/** john: on time & open, sarah: late & open, david: clocked out, emma: on leave, mark: absent. */
async function scenario() {
  await createAttendance({ userId: john.id, workDate: today, clockInUtc: minutesAgo(60) });
  await createAttendance({ userId: sarah.id, workDate: today, clockInUtc: minutesAgo(30), isLate: true });
  await createAttendance({
    userId: david.id,
    workDate: today,
    clockInUtc: minutesAgo(300),
    clockOutUtc: minutesAgo(10),
  });
  await addLeave(emma, yesterday, addDaysToWorkDate(today, 1));
}

describe('GET /admin/attendance/live', () => {
  it('derives a live status per active employee', async () => {
    await scenario();
    const res = await request(app).get('/api/v1/admin/attendance/live').set(auth(admin));
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.data.map((r: { user: { name: string }; status: string }) => [r.user.name, r.status]),
    );
    expect(byName).toEqual({
      'David Ng': 'CLOCKED_OUT',
      'Emma Koh': 'ON_LEAVE',
      'John Lim': 'IN_OFFICE',
      'Mark Tan': 'ABSENT',
      'Sarah Lee': 'LATE',
    });
    const johnRow = res.body.data.find((r: { user: { id: number } }) => r.user.id === john.id);
    expect(johnRow).toEqual({
      user: { id: john.id, name: 'John Lim', initials: 'JL' },
      status: 'IN_OFFICE',
      clockInUtc: expect.stringMatching(/Z$/),
    });
    const markRow = res.body.data.find((r: { user: { id: number } }) => r.user.id === mark.id);
    expect(markRow.clockInUtc).toBeNull();
  });

  it('is admin only', async () => {
    const res = await request(app).get('/api/v1/admin/attendance/live').set(auth(mark));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('GET /admin/overview', () => {
  it('summarises today in SG time', async () => {
    await scenario();
    // Today: 1 of 4 tasks completed (25%). Yesterday: 1 of 2 (50%). Delta: -25.
    await createTask({ assigneeId: mark.id, createdBy: admin.id, dueDate: today, status: 'COMPLETED' });
    await createTask({ assigneeId: mark.id, createdBy: admin.id, dueDate: today });
    await createTask({ assigneeId: john.id, createdBy: admin.id, dueDate: today, status: 'IN_PROGRESS' });
    await createTask({ assigneeId: john.id, createdBy: admin.id, dueDate: today, status: 'CARRIED_OVER' });
    await createTask({ assigneeId: john.id, createdBy: admin.id, dueDate: yesterday, status: 'COMPLETED' });
    await createTask({ assigneeId: john.id, createdBy: admin.id, dueDate: yesterday });
    // Yesterday's attendance must not count.
    await createAttendance({
      userId: mark.id,
      workDate: yesterday,
      clockInUtc: minutesAgo(1500),
      isLate: true,
    });

    const res = await request(app).get('/api/v1/admin/overview').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      totalEmployees: 5,
      inOffice: 3,
      inOfficePct: 60,
      late: { count: 1, names: ['Sarah Lee'] },
      onLeave: 1,
      taskCompletionPct: 25,
      taskCompletionDeltaPct: -25,
    });
  });

  it('handles an empty day', async () => {
    const res = await request(app).get('/api/v1/admin/overview').set(auth(admin));
    expect(res.body.data).toMatchObject({
      inOffice: 0,
      inOfficePct: 0,
      taskCompletionPct: 0,
      taskCompletionDeltaPct: 0,
    });
  });
});

describe('GET /admin/users', () => {
  it('lists active users, optionally by role', async () => {
    const all = await request(app).get('/api/v1/admin/users').set(auth(admin));
    expect(all.body.data).toHaveLength(6);
    const employees = await request(app).get('/api/v1/admin/users?role=EMPLOYEE').set(auth(admin));
    expect(employees.body.data).toHaveLength(5);
    expect(employees.body.data[0]).toEqual({
      id: david.id,
      name: 'David Ng',
      initials: 'DN',
      role: 'EMPLOYEE',
    });
    expect((await request(app).get('/api/v1/admin/users?role=BOSS').set(auth(admin))).status).toBe(400);
  });
});

describe('POST /admin/attendance/manual', () => {
  const manual = (body: object) =>
    request(app)
      .post('/api/v1/admin/attendance/manual')
      .set(auth(admin))
      .send({
        userId: mark.id,
        workDate: yesterday,
        clockInUtc: combineWorkDateAndTime(yesterday, '09:05').toISOString(),
        clockOutUtc: combineWorkDateAndTime(yesterday, '18:05').toISOString(),
        reason: 'Phone battery died',
        ...body,
      });

  it('creates a MANUAL record, recomputes lateness and stores the creator', async () => {
    const res = await manual({});
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      workDate: yesterday,
      clockInUtc: combineWorkDateAndTime(yesterday, '09:05').toISOString().replace('.000Z', 'Z'),
      clockOutUtc: combineWorkDateAndTime(yesterday, '18:05').toISOString().replace('.000Z', 'Z'),
      durationMinutes: 540,
      method: 'MANUAL',
      isLate: false,
      clockInDistanceMeters: null,
    });
    expect(await scalar<number>('SELECT CreatedBy FROM dbo.Attendance')).toBe(admin.id);
    expect(await scalar<string>('SELECT ManualReason FROM dbo.Attendance')).toBe('Phone battery died');

    const late = await manual({
      userId: john.id,
      clockInUtc: combineWorkDateAndTime(yesterday, '09:11').toISOString(),
    });
    expect(late.body.data.isLate).toBe(true);
  });

  it('rejects a record that overlaps an existing one for that user and date', async () => {
    expect((await manual({})).status).toBe(201);
    const again = await manual({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_CLOCKED_IN');
  });

  it('rejects an open manual record while the user has an open shift', async () => {
    await createAttendance({ userId: mark.id, workDate: today, clockInUtc: minutesAgo(10) });
    const res = await manual({ clockOutUtc: null });
    expect(res.status).toBe(409);
  });

  it('validates reason, ordering, work date and future times', async () => {
    expect((await manual({ reason: '' })).status).toBe(400);
    expect(
      (await manual({ clockOutUtc: combineWorkDateAndTime(yesterday, '08:00').toISOString() })).body.error
        .code,
    ).toBe('VALIDATION_ERROR');
    expect((await manual({ workDate: today })).status).toBe(400);
    expect(
      (
        await manual({
          workDate: addDaysToWorkDate(today, 1),
          clockInUtc: combineWorkDateAndTime(addDaysToWorkDate(today, 1), '09:00').toISOString(),
          clockOutUtc: null,
        })
      ).status,
    ).toBe(400);
    expect((await manual({ userId: admin.id })).status).toBe(400);
  });
});

describe('GET /admin/reports', () => {
  it('lists the day’s reports with duration', async () => {
    const shift = await createAttendance({
      userId: mark.id,
      workDate: today,
      clockInUtc: combineWorkDateAndTime(today, '00:00'),
      clockOutUtc: combineWorkDateAndTime(today, '00:45'),
    });
    await scalar(
      `INSERT INTO dbo.DailyReports (AttendanceId, UserId, Summary, Blockers, SubmittedUtc)
       OUTPUT INSERTED.ReportId VALUES (@a, @u, N'Did things', N'None', SYSUTCDATETIME())`,
      (r) => r.input('a', shift).input('u', mark.id),
    );
    const res = await request(app).get(`/api/v1/admin/reports?date=${today}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        reportId: expect.any(Number),
        user: { id: mark.id, name: 'Mark Tan', initials: 'MT' },
        summary: 'Did things',
        blockers: 'None',
        notes: null,
        submittedUtc: expect.stringMatching(/Z$/),
        durationMinutes: 45,
      },
    ]);
    const other = await request(app).get(`/api/v1/admin/reports?date=${yesterday}`).set(auth(admin));
    expect(other.body.data).toEqual([]);
  });
});

describe('leaves', () => {
  it('creates and lists leaves covering a date', async () => {
    const res = await addLeave(mark, today, addDaysToWorkDate(today, 2));
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      userId: mark.id,
      user: { id: mark.id, name: 'Mark Tan', initials: 'MT' },
      fromDate: today,
      toDate: addDaysToWorkDate(today, 2),
      reason: 'Annual leave',
      createdUtc: expect.stringMatching(/Z$/),
      createdBy: { id: admin.id, name: 'Admin' },
    });

    const covering = await request(app)
      .get(`/api/v1/admin/leaves?date=${addDaysToWorkDate(today, 1)}`)
      .set(auth(admin));
    expect(covering.body.data).toHaveLength(1);
    const outside = await request(app)
      .get(`/api/v1/admin/leaves?date=${addDaysToWorkDate(today, 3)}`)
      .set(auth(admin));
    expect(outside.body.data).toHaveLength(0);
    const defaultToday = await request(app).get('/api/v1/admin/leaves').set(auth(admin));
    expect(defaultToday.body.data).toHaveLength(1);
  });

  it('rejects inverted ranges and overlapping leaves', async () => {
    expect((await addLeave(mark, today, yesterday)).status).toBe(400);
    expect((await addLeave(mark, today, today)).status).toBe(201);
    const overlap = await addLeave(mark, yesterday, today);
    expect(overlap.status).toBe(400);
    expect(overlap.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Socket.IO /admin namespace', () => {
  async function startServer() {
    const server = http.createServer(app);
    const io = createSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const url = `http://localhost:${(server.address() as AddressInfo).port}/admin`;
    const close = async () => {
      detachAdminNamespace();
      await io.close();
    };
    return { url, close };
  }

  const connectAs = (url: string, token: string | undefined) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = connect(url, {
        auth: token ? { token } : {},
        transports: ['websocket'],
        reconnection: false,
      });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', (err) => {
        socket.close();
        reject(err);
      });
    });

  it('only accepts admin tokens', async () => {
    const { url, close } = await startServer();
    try {
      await expect(connectAs(url, mark.token)).rejects.toThrow('FORBIDDEN');
      await expect(connectAs(url, undefined)).rejects.toThrow('UNAUTHORIZED');
      await expect(connectAs(url, 'garbage')).rejects.toThrow('UNAUTHORIZED');
      const socket = await connectAs(url, admin.token);
      expect(socket.connected).toBe(true);
      socket.close();
    } finally {
      await close();
    }
  });

  it('emits attendance:updated and overview:updated after a clock-in, and task:updated after task changes', async () => {
    const { url, close } = await startServer();
    const socket = await connectAs(url, admin.token);
    try {
      const attendance = new Promise((resolve) => socket.once('attendance:updated', resolve));
      const overview = new Promise((resolve) => socket.once('overview:updated', resolve));
      const res = await request(app)
        .post('/api/v1/attendance/clock-in')
        .set(auth(mark))
        .send({ ...pointNorth(10), accuracy: 5, isMocked: false });
      expect(res.status).toBe(201);
      expect(await attendance).toEqual({
        user: { id: mark.id, name: 'Mark Tan', initials: 'MT' },
        status: expect.stringMatching(/IN_OFFICE|LATE/),
        clockInUtc: res.body.data.clockInUtc,
      });
      expect(await overview).toMatchObject({ totalEmployees: 5, inOffice: 1 });

      const taskEvent = new Promise((resolve) => socket.once('task:updated', resolve));
      const created = await request(app)
        .post('/api/v1/admin/tasks')
        .set(auth(admin))
        .send({ title: 'Live task', assigneeId: john.id, priority: 'LOW', dueDate: today, dueTime: '17:00' });
      expect(await taskEvent).toEqual({
        id: created.body.data.id,
        title: 'Live task',
        priority: 'LOW',
        status: 'TODO',
        dueUtc: created.body.data.dueUtc,
        attachmentCount: 0,
        assignee: { id: john.id, name: 'John Lim', initials: 'JL' },
      });

      const manualEvent = new Promise((resolve) => socket.once('attendance:updated', resolve));
      await request(app)
        .post('/api/v1/admin/attendance/manual')
        .set(auth(admin))
        .send({
          userId: sarah.id,
          workDate: today,
          clockInUtc: minutesAgo(5).toISOString(),
          clockOutUtc: null,
          reason: 'Forgot phone',
        });
      expect(await manualEvent).toMatchObject({ user: { id: sarah.id } });
    } finally {
      socket.close();
      await close();
    }
  });
});
