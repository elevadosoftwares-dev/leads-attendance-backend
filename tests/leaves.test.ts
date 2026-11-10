import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../src/db/pool';
import { pushService } from '../src/services/push.service';
import { addDaysToWorkDate, todayWorkDate } from '../src/utils/time';
import { app, auth, createOffice, createUser, resetDb, type TestUser } from './helpers';

let officeId: number;
let admin: TestUser;
let mark: TestUser;
let john: TestUser;
const today = todayWorkDate();
const day = (n: number) => addDaysToWorkDate(today, n);

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

const record = (user: TestUser, fromDate: string, toDate: string) =>
  request(app)
    .post('/api/v1/admin/leaves')
    .set(auth(admin))
    .send({ userId: user.id, fromDate, toDate, reason: 'Annual leave' });

const ask = (user: TestUser, fromDate: string, toDate: string, reason = 'Family function') =>
  request(app).post('/api/v1/me/leaves').set(auth(user)).send({ fromDate, toDate, reason });

const act = (action: 'approve' | 'reject' | 'cancel', id: number, note?: string) =>
  request(app)
    .post(`/api/v1/admin/leaves/${id}/${action}`)
    .set(auth(admin))
    .send(note ? { note } : {});

const list = (query: string) => request(app).get(`/api/v1/admin/leaves${query}`).set(auth(admin));

const live = async (user: TestUser) => {
  const res = await request(app).get('/api/v1/admin/attendance/live').set(auth(admin));
  return res.body.data.find((r: { user: { id: number } }) => r.user.id === user.id).status;
};

describe('admin records leave', () => {
  it('is approved at once and lists by date', async () => {
    const notify = vi.spyOn(pushService, 'notifyUsers');
    const res = await record(mark, today, day(2));
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      userId: mark.id,
      user: { id: mark.id, name: 'Mark Tan', initials: 'MT' },
      fromDate: today,
      toDate: day(2),
      days: 3,
      reason: 'Annual leave',
      status: 'APPROVED',
      createdUtc: expect.stringMatching(/Z$/),
      createdBy: { id: admin.id, name: 'Admin' },
      reviewedBy: { id: admin.id, name: 'Admin' },
      reviewedUtc: expect.stringMatching(/Z$/),
      reviewNote: null,
    });
    expect(notify).toHaveBeenCalledWith([mark.id], expect.objectContaining({ title: 'Leave recorded' }));

    expect((await list(`?date=${day(1)}`)).body.data).toHaveLength(1);
    expect((await list(`?date=${day(3)}`)).body.data).toHaveLength(0);
    expect((await list('')).body.data).toHaveLength(1); // current and upcoming approved
    expect(await live(mark)).toBe('ON_LEAVE');
  });

  it('rejects inverted ranges, overlaps and non-employees', async () => {
    expect((await record(mark, today, day(-1))).status).toBe(400);
    expect((await record(mark, today, today)).status).toBe(201);
    const overlap = await record(mark, day(-1), today);
    expect(overlap.status).toBe(400);
    expect(overlap.body.error.code).toBe('VALIDATION_ERROR');
    expect((await record(admin, day(1), day(1))).status).toBe(400);
  });

  it('is admin only', async () => {
    expect((await request(app).get('/api/v1/admin/leaves').set(auth(mark))).status).toBe(403);
  });
});

describe('employee requests leave', () => {
  it('waits for approval, then counts as leave', async () => {
    const notifyAdmins = vi.spyOn(pushService, 'notifyAllActive');
    const notifyUser = vi.spyOn(pushService, 'notifyUsers');
    const res = await ask(mark, today, day(1));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'PENDING',
      days: 2,
      createdBy: { id: mark.id, name: 'Mark Tan' },
      reviewedBy: null,
    });
    expect(notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Leave request',
        data: expect.objectContaining({ type: 'LEAVE_REQUEST' }),
      }),
      ['ADMIN', 'SUPER_ADMIN'],
    );
    // Pending leave doesn't count yet.
    expect(await live(mark)).toBe('ABSENT');
    expect((await list('?status=PENDING')).body.data).toHaveLength(1);

    const approved = await act('approve', res.body.data.id, 'Enjoy');
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: 'APPROVED',
      reviewedBy: { id: admin.id, name: 'Admin' },
      reviewNote: 'Enjoy',
    });
    expect(notifyUser).toHaveBeenCalledWith([mark.id], expect.objectContaining({ title: 'Leave approved' }));
    expect(await live(mark)).toBe('ON_LEAVE');
    expect((await list('?status=PENDING')).body.data).toHaveLength(0);

    // Only pending requests can be reviewed.
    expect((await act('reject', res.body.data.id)).status).toBe(400);
  });

  it('can be rejected, and a rejected request does not block a new one', async () => {
    const res = await ask(mark, day(1), day(1));
    const rejected = await act('reject', res.body.data.id, 'Busy week');
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', reviewNote: 'Busy week' });
    expect((await ask(mark, day(1), day(1))).status).toBe(201);
    expect((await list('?status=REJECTED')).body.data).toHaveLength(1);
  });

  it('cannot start in the past or overlap pending leave', async () => {
    expect((await ask(mark, day(-1), today)).status).toBe(400);
    expect((await ask(mark, day(2), day(4))).status).toBe(201);
    expect((await ask(mark, day(4), day(5))).status).toBe(400);
    expect((await ask(mark, day(4), day(5), '')).status).toBe(400);
  });

  it('lists only my own leave, newest first', async () => {
    await ask(mark, day(1), day(1));
    await ask(mark, day(5), day(6));
    await ask(john, day(1), day(1));
    const mine = await request(app).get('/api/v1/me/leaves').set(auth(mark));
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((l: { fromDate: string }) => l.fromDate)).toEqual([day(5), day(1)]);
    expect((await request(app).get('/api/v1/me/leaves').set(auth(admin))).status).toBe(403);
  });
});

describe('cancelling and withdrawing', () => {
  it('lets an admin cancel current leave', async () => {
    const leave = await record(mark, today, day(1));
    const res = await act('cancel', leave.body.data.id, 'Called back');
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', reviewNote: 'Called back' });
    expect(await live(mark)).toBe('ABSENT');
    expect((await act('cancel', leave.body.data.id)).status).toBe(400);
    // The dates are free again.
    expect((await record(mark, today, today)).status).toBe(201);
  });

  it('does not cancel leave that has ended', async () => {
    const leave = await record(mark, day(-3), day(-2));
    expect((await act('cancel', leave.body.data.id)).status).toBe(400);
  });

  it('lets an employee withdraw pending or not-yet-started leave', async () => {
    const withdraw = (user: TestUser, id: number) =>
      request(app).post(`/api/v1/me/leaves/${id}/withdraw`).set(auth(user)).send();

    const pending = await ask(mark, day(1), day(1));
    expect((await withdraw(john, pending.body.data.id)).status).toBe(404);
    expect((await withdraw(mark, pending.body.data.id)).body.data.status).toBe('CANCELLED');

    const future = await record(mark, day(3), day(3));
    expect((await withdraw(mark, future.body.data.id)).body.data.status).toBe('CANCELLED');

    const started = await record(mark, today, day(1));
    const refused = await withdraw(mark, started.body.data.id);
    expect(refused.status).toBe(400);
  });
});

describe('attendance history', () => {
  it('includes approved leave in the month', async () => {
    await record(mark, today, today);
    await ask(mark, day(1), day(1)); // pending: not shown
    const res = await request(app).get('/api/v1/attendance/history').set(auth(mark));
    expect(res.status).toBe(200);
    expect(res.body.data.leaves).toEqual([
      { id: expect.any(Number), fromDate: today, toDate: today, reason: 'Annual leave' },
    ]);
  });
});
