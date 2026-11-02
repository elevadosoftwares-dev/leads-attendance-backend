import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { closePool } from '../src/db/pool';
import { signAccessToken } from '../src/modules/auth/token.service';
import { addDaysToWorkDate, combineWorkDateAndTime, nextWorkDate, todayWorkDate } from '../src/utils/time';
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

beforeEach(async () => {
  await resetDb();
  officeId = await createOffice();
  admin = await createUser(officeId, { role: 'ADMIN', name: 'Admin' });
  mark = await createUser(officeId, { name: 'Mark Tan' });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closePool();
});

const fix = (meters: number, extra: Partial<{ accuracy: number; isMocked: boolean }> = {}) => ({
  ...pointNorth(meters),
  accuracy: extra.accuracy ?? 10,
  isMocked: extra.isMocked ?? false,
});

const clockIn = (user: TestUser, body: object) =>
  request(app).post('/api/v1/attendance/clock-in').set(auth(user)).send(body);

const clockOut = (user: TestUser, body: object) =>
  request(app)
    .post('/api/v1/attendance/clock-out')
    .set(auth(user))
    .send({ ...fix(20), summary: 'Finished the UT inspection.', carryOverTaskIds: [], ...body });

/** Freezes Date (only) at a Singapore local time today and re-signs the user's token for that clock. */
function freezeAt(user: TestUser, localTime: string) {
  vi.useFakeTimers({ toFake: ['Date'], now: combineWorkDateAndTime(todayWorkDate(), localTime) });
  user.token = signAccessToken({ id: user.id, role: user.role });
}

describe('POST /attendance/clock-in (geofence validation)', () => {
  it('clocks in inside the radius and stores the server-computed distance', async () => {
    const res = await clockIn(mark, fix(42));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      workDate: todayWorkDate(),
      clockOutUtc: null,
      durationMinutes: null,
      method: 'GEOFENCE',
      clockInDistanceMeters: 42,
    });
    expect(res.body.data.clockInUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(await scalar<number>('SELECT InAccuracy FROM dbo.Attendance')).toBe(10);
  });

  it('rejects a fix outside the radius with OUTSIDE_GEOFENCE and the distance', async () => {
    const res = await clockIn(mark, fix(200));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OUTSIDE_GEOFENCE');
    expect(res.body.error.details).toEqual({ distanceMeters: 200, radiusMeters: 150 });
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.Attendance')).toBe(0);
  });

  it('accepts a fix just inside the boundary and rejects one just outside', async () => {
    expect((await clockIn(mark, fix(149))).status).toBe(201);
    const john = await createUser(officeId, { name: 'John Lim' });
    expect((await clockIn(john, fix(151))).body.error.code).toBe('OUTSIDE_GEOFENCE');
  });

  it('rejects low accuracy with LOW_ACCURACY', async () => {
    const res = await clockIn(mark, fix(10, { accuracy: 80 }));
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'LOW_ACCURACY',
      details: { accuracy: 80, maxAccuracy: 50 },
    });
  });

  it('rejects mocked locations first, before accuracy and distance', async () => {
    const res = await clockIn(mark, fix(5000, { accuracy: 500, isMocked: true }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MOCK_LOCATION');
  });

  it('checks accuracy before distance', async () => {
    const res = await clockIn(mark, fix(5000, { accuracy: 500 }));
    expect(res.body.error.code).toBe('LOW_ACCURACY');
  });

  it('ignores any client-supplied distance', async () => {
    const res = await clockIn(mark, { ...fix(500), distanceMeters: 1 });
    expect(res.body.error.code).toBe('OUTSIDE_GEOFENCE');
  });

  it('validates the body', async () => {
    const res = await clockIn(mark, { latitude: 200, longitude: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('is for employees only', async () => {
    const res = await clockIn(admin, fix(10));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('one open shift', () => {
  it('rejects a second clock-in with ALREADY_CLOCKED_IN', async () => {
    expect((await clockIn(mark, fix(10))).status).toBe(201);
    const second = await clockIn(mark, fix(10));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_CLOCKED_IN');
  });

  it('is race-safe: concurrent clock-ins produce exactly one shift', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => clockIn(mark, fix(10))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.error.code).toBe('ALREADY_CLOCKED_IN');
    }
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.Attendance')).toBe(1);
  });

  it('rejects clocking in again after clocking out the same day', async () => {
    await clockIn(mark, fix(10));
    expect((await clockOut(mark, {})).status).toBe(200);
    const again = await clockIn(mark, fix(10));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_CLOCKED_IN');
  });
});

describe('lateness (shift 09:00 + 10 minutes grace, SG time)', () => {
  it('is on time at exactly 09:10:00', async () => {
    freezeAt(mark, '09:10');
    const res = await clockIn(mark, fix(10));
    expect(res.status).toBe(201);
    expect(res.body.data.isLate).toBe(false);
  });

  it('is late at 09:10:01', async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: combineWorkDateAndTime(todayWorkDate(), '09:10').getTime() + 1000,
    });
    mark.token = signAccessToken({ id: mark.id, role: mark.role });
    const res = await clockIn(mark, fix(10));
    expect(res.status).toBe(201);
    expect(res.body.data.isLate).toBe(true);
  });

  it('is on time early in the morning', async () => {
    freezeAt(mark, '08:30');
    expect((await clockIn(mark, fix(10))).body.data.isLate).toBe(false);
  });

  it('uses the user’s own shift start', async () => {
    const late = await createUser(officeId, { name: 'Late Shift', shiftStart: '13:00' });
    freezeAt(late, '13:05');
    expect((await clockIn(late, fix(10))).body.data.isLate).toBe(false);
  });

  it('uses the Singapore date: 00:30 SG belongs to the new SG day', async () => {
    freezeAt(mark, '00:30');
    const res = await clockIn(mark, fix(10));
    expect(res.body.data.workDate).toBe(todayWorkDate());
    expect(res.body.data.isLate).toBe(false);
  });
});

describe('GET /me/today', () => {
  it('reports status transitions and a task preview with unfinished tasks first', async () => {
    const today = todayWorkDate();
    await createTask({
      assigneeId: mark.id,
      createdBy: admin.id,
      dueDate: today,
      dueTime: '09:30',
      status: 'COMPLETED',
    });
    await createTask({ assigneeId: mark.id, createdBy: admin.id, dueDate: today, dueTime: '11:00' });
    await createTask({
      assigneeId: mark.id,
      createdBy: admin.id,
      dueDate: today,
      dueTime: '15:00',
      status: 'IN_PROGRESS',
    });
    await createTask({
      assigneeId: mark.id,
      createdBy: admin.id,
      dueDate: today,
      dueTime: '12:00',
      status: 'CARRIED_OVER',
    });
    await createTask({ assigneeId: mark.id, createdBy: admin.id, dueDate: addDaysToWorkDate(today, 1) });

    const before = await request(app).get('/api/v1/me/today').set(auth(mark));
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({
      date: today,
      office: {
        id: officeId,
        name: 'LEADS Office Geofence',
        latitude: 1.417,
        longitude: 103.868,
        radiusMeters: 150,
      },
      attendance: { status: 'NOT_CLOCKED_IN', record: null },
      tasks: { total: 4, completed: 1 },
    });
    const preview = before.body.data.tasks.preview;
    expect(preview).toHaveLength(3);
    expect(preview.map((t: { status: string }) => t.status)).toEqual(['IN_PROGRESS', 'TODO', 'CARRIED_OVER']);
    expect(preview[0]).toEqual({
      id: expect.any(Number),
      title: expect.any(String),
      priority: 'MEDIUM',
      status: 'IN_PROGRESS',
      dueUtc: expect.stringMatching(/Z$/),
      attachmentCount: 0,
    });

    await clockIn(mark, fix(10));
    const during = await request(app).get('/api/v1/me/today').set(auth(mark));
    expect(during.body.data.attendance.status).toBe('CLOCKED_IN');
    expect(during.body.data.attendance.record.clockOutUtc).toBeNull();

    await clockOut(mark, {});
    const after = await request(app).get('/api/v1/me/today').set(auth(mark));
    expect(after.body.data.attendance.status).toBe('CLOCKED_OUT');
    expect(after.body.data.attendance.record.clockOutUtc).not.toBeNull();
  });

  it('is for employees only', async () => {
    expect((await request(app).get('/api/v1/me/today').set(auth(admin))).status).toBe(403);
  });
});

describe('GET /attendance/current', () => {
  it('returns NO_OPEN_SHIFT when not clocked in', async () => {
    const res = await request(app).get('/api/v1/attendance/current').set(auth(mark));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_OPEN_SHIFT');
  });

  it('returns the open shift, elapsed minutes and the day’s tasks', async () => {
    const today = todayWorkDate();
    await createTask({ assigneeId: mark.id, createdBy: admin.id, dueDate: today });
    await createAttendance({
      userId: mark.id,
      workDate: today,
      clockInUtc: new Date(Date.now() - 95 * 60_000),
    });
    const res = await request(app).get('/api/v1/attendance/current').set(auth(mark));
    expect(res.status).toBe(200);
    expect(res.body.data.attendance.clockOutUtc).toBeNull();
    expect(res.body.data.elapsedMinutes).toBeGreaterThanOrEqual(94);
    expect(res.body.data.elapsedMinutes).toBeLessThanOrEqual(96);
    expect(res.body.data.tasks).toHaveLength(1);
  });
});

describe('POST /attendance/clock-out', () => {
  it('returns NO_OPEN_SHIFT when not clocked in', async () => {
    const res = await clockOut(mark, {});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_OPEN_SHIFT');
  });

  it('writes the report, carries over tasks to the next work day and closes the shift', async () => {
    const today = todayWorkDate();
    const carry = await createTask({
      assigneeId: mark.id,
      createdBy: admin.id,
      dueDate: today,
      dueTime: '15:30',
    });
    const untouched = await createTask({ assigneeId: mark.id, createdBy: admin.id, dueDate: today });
    await createAttendance({
      userId: mark.id,
      workDate: today,
      clockInUtc: new Date(Date.now() - 480 * 60_000),
    });

    const res = await clockOut(mark, {
      summary: '  Completed UT on MLG.  ',
      blockers: 'Waiting for parts',
      carryOverTaskIds: [carry, carry],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ attendance: expect.any(Object), reportId: expect.any(Number) });
    expect(res.body.data.attendance.clockOutUtc).not.toBeNull();
    expect(res.body.data.attendance.durationMinutes).toBeGreaterThanOrEqual(479);

    const report = await scalar<string>('SELECT Summary FROM dbo.DailyReports');
    expect(report).toBe('Completed UT on MLG.');
    expect(await scalar<string>('SELECT Blockers FROM dbo.DailyReports')).toBe('Waiting for parts');

    const next = nextWorkDate(today);
    const moved = await scalar<Date>('SELECT DueUtc FROM dbo.Tasks WHERE TaskId = @id', (r) =>
      r.input('id', carry),
    );
    expect(moved.toISOString()).toBe(combineWorkDateAndTime(next, '15:30').toISOString());
    expect(
      await scalar<string>('SELECT Status FROM dbo.Tasks WHERE TaskId = @id', (r) => r.input('id', carry)),
    ).toBe('CARRIED_OVER');
    const movedDate = await scalar<Date>('SELECT DueWorkDate FROM dbo.Tasks WHERE TaskId = @id', (r) =>
      r.input('id', carry),
    );
    expect(movedDate.toISOString().slice(0, 10)).toBe(next);
    expect(
      await scalar<string>('SELECT Status FROM dbo.Tasks WHERE TaskId = @id', (r) =>
        r.input('id', untouched),
      ),
    ).toBe('TODO');
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.Attendance WHERE OutLat IS NOT NULL')).toBe(1);
  });

  it('rolls everything back when a carry-over task is already completed', async () => {
    const today = todayWorkDate();
    const open = await createTask({ assigneeId: mark.id, createdBy: admin.id, dueDate: today });
    const done = await createTask({
      assigneeId: mark.id,
      createdBy: admin.id,
      dueDate: today,
      status: 'COMPLETED',
    });
    await createAttendance({ userId: mark.id, workDate: today, clockInUtc: new Date(Date.now() - 60_000) });

    const res = await clockOut(mark, { carryOverTaskIds: [open, done] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.DailyReports')).toBe(0);
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.Attendance WHERE ClockOutUtc IS NULL')).toBe(1);
    expect(
      await scalar<string>('SELECT Status FROM dbo.Tasks WHERE TaskId = @id', (r) => r.input('id', open)),
    ).toBe('TODO');
  });

  it('rolls back and returns FORBIDDEN when carrying over someone else’s task', async () => {
    const today = todayWorkDate();
    const john = await createUser(officeId, { name: 'John Lim' });
    const johns = await createTask({ assigneeId: john.id, createdBy: admin.id, dueDate: today });
    await createAttendance({ userId: mark.id, workDate: today, clockInUtc: new Date(Date.now() - 60_000) });

    const res = await clockOut(mark, { carryOverTaskIds: [johns] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.DailyReports')).toBe(0);
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.Attendance WHERE ClockOutUtc IS NULL')).toBe(1);
  });

  it('rejects unknown carry-over task ids and rolls back', async () => {
    await createAttendance({
      userId: mark.id,
      workDate: todayWorkDate(),
      clockInUtc: new Date(Date.now() - 60_000),
    });
    const res = await clockOut(mark, { carryOverTaskIds: [999999] });
    expect(res.status).toBe(400);
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.DailyReports')).toBe(0);
  });

  it('requires a summary of 1–2000 characters', async () => {
    await createAttendance({
      userId: mark.id,
      workDate: todayWorkDate(),
      clockInUtc: new Date(Date.now() - 60_000),
    });
    expect((await clockOut(mark, { summary: '   ' })).status).toBe(400);
    expect((await clockOut(mark, { summary: 'x'.repeat(2001) })).status).toBe(400);
    expect((await clockOut(mark, { summary: 'x'.repeat(2000) })).status).toBe(200);
  });

  it('records but does not enforce the geofence by default', async () => {
    await createAttendance({
      userId: mark.id,
      workDate: todayWorkDate(),
      clockInUtc: new Date(Date.now() - 60_000),
    });
    const res = await clockOut(mark, { ...fix(2000) });
    expect(res.status).toBe(200);
    expect(Math.round(await scalar<number>('SELECT OutDistanceMeters FROM dbo.Attendance'))).toBe(2000);
  });

  it('enforces the geofence when CLOCK_OUT_REQUIRES_GEOFENCE=true', async () => {
    env.CLOCK_OUT_REQUIRES_GEOFENCE = true;
    try {
      await createAttendance({
        userId: mark.id,
        workDate: todayWorkDate(),
        clockInUtc: new Date(Date.now() - 60_000),
      });
      const res = await clockOut(mark, { ...fix(2000) });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('OUTSIDE_GEOFENCE');
      expect(await scalar<number>('SELECT COUNT(*) FROM dbo.DailyReports')).toBe(0);
    } finally {
      env.CLOCK_OUT_REQUIRES_GEOFENCE = false;
    }
  });

  it('always rejects mocked locations', async () => {
    await createAttendance({
      userId: mark.id,
      workDate: todayWorkDate(),
      clockInUtc: new Date(Date.now() - 60_000),
    });
    const res = await clockOut(mark, { ...fix(10, { isMocked: true }) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MOCK_LOCATION');
  });
});

describe('GET /attendance/history', () => {
  it('returns days newest first with stats for the month', async () => {
    const at = (date: string, time: string) => combineWorkDateAndTime(date, time);
    // Two closed shifts (480 and 540 minutes) and one open shift in October 2026.
    await createAttendance({
      userId: mark.id,
      workDate: '2026-10-05',
      clockInUtc: at('2026-10-05', '09:00'),
      clockOutUtc: at('2026-10-05', '17:00'),
    });
    await createAttendance({
      userId: mark.id,
      workDate: '2026-10-06',
      clockInUtc: at('2026-10-06', '09:30'),
      clockOutUtc: at('2026-10-06', '18:30'),
      isLate: true,
    });
    await createAttendance({
      userId: mark.id,
      workDate: '2026-10-07',
      clockInUtc: at('2026-10-07', '09:00'),
    });
    // Outside the month.
    await createAttendance({
      userId: mark.id,
      workDate: '2026-09-30',
      clockInUtc: at('2026-09-30', '09:00'),
      clockOutUtc: at('2026-09-30', '10:00'),
    });

    await createTask({
      assigneeId: mark.id,
      createdBy: admin.id,
      dueDate: '2026-10-05',
      status: 'COMPLETED',
    });
    await createTask({ assigneeId: mark.id, createdBy: admin.id, dueDate: '2026-10-05' });
    await createTask({
      assigneeId: mark.id,
      createdBy: admin.id,
      dueDate: '2026-10-20',
      status: 'COMPLETED',
    });

    const res = await request(app).get('/api/v1/attendance/history?month=2026-10').set(auth(mark));
    expect(res.status).toBe(200);
    expect(res.body.data.month).toBe('2026-10');
    expect(res.body.data.stats).toEqual({ avgMinutes: 510, taskCompletionRate: 67 });
    expect(res.body.data.days.map((d: { workDate: string }) => d.workDate)).toEqual([
      '2026-10-07',
      '2026-10-06',
      '2026-10-05',
    ]);
    expect(res.body.data.days[2]).toEqual({
      workDate: '2026-10-05',
      clockInUtc: '2026-10-05T01:00:00Z',
      clockOutUtc: '2026-10-05T09:00:00Z',
      durationMinutes: 480,
      method: 'GEOFENCE',
      isLate: false,
      tasksCompleted: 1,
      tasksTotal: 2,
    });
    expect(res.body.data.days[0].durationMinutes).toBeNull();
  });

  it('defaults to the current month and validates the format', async () => {
    const ok = await request(app).get('/api/v1/attendance/history').set(auth(mark));
    expect(ok.status).toBe(200);
    expect(ok.body.data.month).toBe(todayWorkDate().slice(0, 7));
    expect(ok.body.data.stats).toEqual({ avgMinutes: 0, taskCompletionRate: 0 });

    const bad = await request(app).get('/api/v1/attendance/history?month=2026-13').set(auth(mark));
    expect(bad.status).toBe(400);
  });
});
