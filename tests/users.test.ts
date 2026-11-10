import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { closePool } from '../src/db/pool';
import { setMessagingClient } from '../src/services/push.service';
import { PASSWORD, auth, createOffice, createUser, resetDb, scalar, type TestUser } from './helpers';

let officeId: number;
let superAdmin: TestUser;
let admin: TestUser;
let mark: TestUser;
// A fresh app per test, so the auth rate limiters start empty.
let api: ReturnType<typeof createApp>;

beforeEach(async () => {
  api = createApp();
  await resetDb();
  officeId = await createOffice();
  superAdmin = await createUser(officeId, {
    role: 'SUPER_ADMIN',
    name: 'Super Admin',
    email: 'superadmin@leads-ndt.com',
  });
  admin = await createUser(officeId, { role: 'ADMIN', name: 'Admin', email: 'admin@leads-ndt.com' });
  mark = await createUser(officeId, { name: 'Mark Tan', email: 'mark.tan@leads-ndt.com' });
});

afterEach(() => setMessagingClient(undefined));

afterAll(async () => {
  await closePool();
});

const NEW_PASSWORD = 'Fresh-pass-9';
const signup = (body: Record<string, unknown>) => request(api).post('/api/v1/auth/signup').send(body);
const login = (email: string, password: string) =>
  request(api).post('/api/v1/auth/login').send({ email, password });
const jane = { name: 'Jane Lim', email: 'Jane.Lim@Gmail.com', password: NEW_PASSWORD };

async function signUpJane(): Promise<number> {
  const res = await signup(jane);
  expect(res.status).toBe(201);
  return res.body.data.id;
}

describe('POST /auth/signup', () => {
  it('creates a PENDING employee that cannot log in yet', async () => {
    const res = await signup(jane);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      name: 'Jane Lim',
      email: 'jane.lim@gmail.com',
      status: 'PENDING',
    });
    const attempt = await login('jane.lim@gmail.com', NEW_PASSWORD);
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.code).toBe('ACCOUNT_PENDING');
    expect((await login('jane.lim@gmail.com', 'Wrong-pass-1')).body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('never creates an admin, whatever the body says', async () => {
    const res = await signup({ ...jane, role: 'ADMIN' });
    expect(res.status).toBe(201);
    const role = await scalar<string>('SELECT Role FROM dbo.Users WHERE UserId = @id', (r) =>
      r.input('id', res.body.data.id),
    );
    expect(role).toBe('EMPLOYEE');
  });

  it('rejects an email that is already registered', async () => {
    const res = await signup({ ...jane, email: 'MARK.TAN@leads-ndt.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('validates name, email and password strength', async () => {
    const res = await signup({ name: 'J', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    const fields = new Set(res.body.error.details.fields.map((f: { field: string }) => f.field));
    expect([...fields].sort()).toEqual(['email', 'name', 'password']);
  });

  it('notifies admins by push', async () => {
    const sendEachForMulticast = vi.fn(async (m: MulticastMessage): Promise<BatchResponse> => ({
      responses: m.tokens.map(() => ({ success: true, messageId: 'x' })),
      successCount: m.tokens.length,
      failureCount: 0,
    }));
    setMessagingClient({ sendEachForMulticast });
    await request(api)
      .post('/api/v1/me/device-token')
      .set(auth(admin))
      .send({ fcmToken: 'admin-device-token-01', platform: 'android' });
    await request(api)
      .post('/api/v1/me/device-token')
      .set(auth(superAdmin))
      .send({ fcmToken: 'super-device-token-01', platform: 'ios' });
    await request(api)
      .post('/api/v1/me/device-token')
      .set(auth(mark))
      .send({ fcmToken: 'mark-device-token-001', platform: 'android' });

    await signUpJane();
    await vi.waitFor(() => expect(sendEachForMulticast).toHaveBeenCalledTimes(1));
    const message = sendEachForMulticast.mock.calls[0]![0];
    expect([...message.tokens].sort()).toEqual(['admin-device-token-01', 'super-device-token-01']);
    expect(message.data).toEqual({ type: 'USER_PENDING', userId: expect.any(String) });
  });

  it('is rate limited per IP and email', async () => {
    for (let i = 0; i < 5; i++) await signup({ ...jane, email: 'mark.tan@leads-ndt.com' });
    const res = await signup({ ...jane, email: 'mark.tan@leads-ndt.com' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('approving and rejecting sign-ups', () => {
  it('lists pending sign-ups; an admin approves with the office shift start', async () => {
    const id = await signUpJane();
    const pending = await request(api).get('/api/v1/admin/users?status=PENDING').set(auth(admin));
    expect(pending.status).toBe(200);
    expect(pending.body.data.map((u: { id: number }) => u.id)).toEqual([id]);
    expect(pending.body.data[0].status).toBe('PENDING');

    const res = await request(api).post(`/api/v1/admin/users/${id}/approve`).set(auth(admin)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, status: 'ACTIVE', role: 'EMPLOYEE', shiftStart: '09:00' });
    expect((await login(jane.email, NEW_PASSWORD)).status).toBe(200);

    const again = await request(api).post(`/api/v1/admin/users/${id}/approve`).set(auth(admin)).send({});
    expect(again.status).toBe(400);
  });

  it('only the super admin may set a shift start while approving', async () => {
    const id = await signUpJane();
    const byAdmin = await request(api)
      .post(`/api/v1/admin/users/${id}/approve`)
      .set(auth(admin))
      .send({ shiftStart: '08:30' });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.code).toBe('FORBIDDEN');

    const bySuper = await request(api)
      .post(`/api/v1/admin/users/${id}/approve`)
      .set(auth(superAdmin))
      .send({ shiftStart: '08:30' });
    expect(bySuper.status).toBe(200);
    expect(bySuper.body.data.shiftStart).toBe('08:30');
  });

  it('rejecting deletes the sign-up so the person can register again', async () => {
    const id = await signUpJane();
    const res = await request(api).post(`/api/v1/admin/users/${id}/reject`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(
      await scalar<number>('SELECT COUNT(*) FROM dbo.Users WHERE UserId = @id', (r) => r.input('id', id)),
    ).toBe(0);
    expect((await signup(jane)).status).toBe(201);
  });

  it('refuses to reject an active user', async () => {
    const res = await request(api).post(`/api/v1/admin/users/${mark.id}/reject`).set(auth(admin));
    expect(res.status).toBe(400);
  });

  it('is admin only', async () => {
    const id = await signUpJane();
    const res = await request(api).post(`/api/v1/admin/users/${id}/approve`).set(auth(mark)).send({});
    expect(res.status).toBe(403);
    expect((await request(api).get('/api/v1/admin/users?status=PENDING').set(auth(mark))).status).toBe(403);
  });
});

describe('POST /admin/users', () => {
  const grace = { name: 'Grace Ong', email: 'grace.ong@leads-ndt.com', password: NEW_PASSWORD };

  it('lets an admin create an employee with the office shift start, but not choose the shift', async () => {
    const res = await request(api)
      .post('/api/v1/admin/users')
      .set(auth(admin))
      .send({ ...grace, role: 'EMPLOYEE' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ role: 'EMPLOYEE', status: 'ACTIVE', shiftStart: '09:00' });

    const withShift = await request(api)
      .post('/api/v1/admin/users')
      .set(auth(admin))
      .send({ ...grace, email: 'other@leads-ndt.com', role: 'EMPLOYEE', shiftStart: '07:00' });
    expect(withShift.status).toBe(403);
  });

  it('only the super admin can create admins, and nobody can create a super admin', async () => {
    const byAdmin = await request(api)
      .post('/api/v1/admin/users')
      .set(auth(admin))
      .send({ ...grace, role: 'ADMIN' });
    expect(byAdmin.status).toBe(403);
    const superRole = await request(api)
      .post('/api/v1/admin/users')
      .set(auth(superAdmin))
      .send({ ...grace, role: 'SUPER_ADMIN' });
    expect(superRole.status).toBe(400);
  });

  it('creates an active admin (super admin) who can log in straight away', async () => {
    const res = await request(api)
      .post('/api/v1/admin/users')
      .set(auth(superAdmin))
      .send({ ...grace, role: 'ADMIN' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      name: 'Grace Ong',
      email: 'grace.ong@leads-ndt.com',
      role: 'ADMIN',
      initials: 'GO',
      status: 'ACTIVE',
      shiftStart: '09:00',
      shiftEnd: '18:00',
      createdUtc: expect.stringMatching(/Z$/),
    });
    const session = await login('grace.ong@leads-ndt.com', NEW_PASSWORD);
    expect(session.status).toBe(200);
    expect(session.body.data.user.role).toBe('ADMIN');
  });

  it('rejects duplicate emails and is admin only', async () => {
    const body = {
      name: 'Mark Two',
      email: 'mark.tan@leads-ndt.com',
      password: NEW_PASSWORD,
      role: 'EMPLOYEE',
    };
    expect((await request(api).post('/api/v1/admin/users').set(auth(admin)).send(body)).body.error.code).toBe(
      'EMAIL_TAKEN',
    );
    expect((await request(api).post('/api/v1/admin/users').set(auth(mark)).send(body)).status).toBe(403);
  });
});

describe('PATCH /admin/users/:id', () => {
  it('the super admin promotes an employee; the new role applies to their existing token', async () => {
    const res = await request(api)
      .patch(`/api/v1/admin/users/${mark.id}`)
      .set(auth(superAdmin))
      .send({ role: 'ADMIN', shiftStart: '10:00' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: 'ADMIN', shiftStart: '10:00', name: 'Mark Tan' });
    // mark's token still says EMPLOYEE, but the role is re-read from the database.
    expect((await request(api).get('/api/v1/admin/overview').set(auth(mark))).status).toBe(200);
  });

  it('admins may rename employees but not change roles or shift times', async () => {
    const rename = await request(api)
      .patch(`/api/v1/admin/users/${mark.id}`)
      .set(auth(admin))
      .send({ name: 'Mark T' });
    expect(rename.status).toBe(200);
    for (const body of [{ role: 'ADMIN' }, { shiftStart: '10:00' }, { shiftEnd: '17:00' }]) {
      const res = await request(api).patch(`/api/v1/admin/users/${mark.id}`).set(auth(admin)).send(body);
      expect(res.status).toBe(403);
    }
  });

  it('the super admin sets the shift end, which must be after the start', async () => {
    const patch = (body: object) =>
      request(api).patch(`/api/v1/admin/users/${mark.id}`).set(auth(superAdmin)).send(body);
    const res = await patch({ shiftEnd: '17:00' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ shiftStart: '09:00', shiftEnd: '17:00' });
    const early = await patch({ shiftEnd: '08:00' });
    expect(early.status).toBe(400);
    expect(early.body.error.details.fields[0].field).toBe('shiftEnd');
    expect((await patch({ shiftStart: '17:30' })).status).toBe(400);
    expect((await patch({ shiftStart: '13:00', shiftEnd: '21:00' })).body.data).toMatchObject({
      shiftStart: '13:00',
      shiftEnd: '21:00',
    });
  });

  it('admins cannot edit other admins or the super admin', async () => {
    const other = await createUser(officeId, { role: 'ADMIN', name: 'Other Admin' });
    for (const target of [other, superAdmin]) {
      const res = await request(api)
        .patch(`/api/v1/admin/users/${target.id}`)
        .set(auth(admin))
        .send({ name: 'Renamed Person' });
      expect(res.status).toBe(403);
    }
  });

  it('lets anyone rename themselves, but nobody changes their own role', async () => {
    const self = await request(api)
      .patch(`/api/v1/admin/users/${admin.id}`)
      .set(auth(admin))
      .send({ name: 'Head Admin' });
    expect(self.status).toBe(200);
    const res = await request(api)
      .patch(`/api/v1/admin/users/${superAdmin.id}`)
      .set(auth(superAdmin))
      .send({ role: 'EMPLOYEE' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields[0].field).toBe('role');
  });

  it('requires at least one field and a known user', async () => {
    expect(
      (await request(api).patch(`/api/v1/admin/users/${mark.id}`).set(auth(admin)).send({})).status,
    ).toBe(400);
    expect(
      (await request(api).patch('/api/v1/admin/users/999999').set(auth(admin)).send({ name: 'X Y' })).status,
    ).toBe(404);
  });
});

describe('DELETE /admin/users/:id (deactivate)', () => {
  it('locks the user out at once and keeps their history', async () => {
    const session = await login(mark.email, PASSWORD);
    await request(api)
      .post('/api/v1/me/device-token')
      .set(auth(mark))
      .send({ fcmToken: 'mark-device-token-001', platform: 'android' });

    const res = await request(api).delete(`/api/v1/admin/users/${mark.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: mark.id, status: 'INACTIVE' });

    // The still-unexpired access token, the refresh token and the password all stop working.
    // All three say ACCOUNT_INACTIVE so the app can explain why the session ended.
    const me = await request(api).get('/api/v1/me').set(auth(mark));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('ACCOUNT_INACTIVE');
    const refresh = await request(api)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.body.data.refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error.code).toBe('ACCOUNT_INACTIVE');
    expect((await login(mark.email, PASSWORD)).body.error.code).toBe('ACCOUNT_INACTIVE');
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.DeviceTokens')).toBe(0);
    expect(
      await scalar<number>('SELECT COUNT(*) FROM dbo.Users WHERE UserId = @id', (r) =>
        r.input('id', mark.id),
      ),
    ).toBe(1);

    const active = await request(api).get('/api/v1/admin/users').set(auth(admin));
    expect(active.body.data.map((u: { id: number }) => u.id)).toEqual([admin.id, superAdmin.id]);
    const removed = await request(api).get('/api/v1/admin/users?status=INACTIVE').set(auth(admin));
    expect(removed.body.data.map((u: { id: number }) => u.id)).toEqual([mark.id]);
  });

  it('refuses to remove yourself', async () => {
    const res = await request(api).delete(`/api/v1/admin/users/${admin.id}`).set(auth(admin));
    expect(res.status).toBe(400);
  });

  it('only the super admin removes admins, and the super admin cannot be removed', async () => {
    const second = await createUser(officeId, { role: 'ADMIN', name: 'Second Admin' });
    expect((await request(api).delete(`/api/v1/admin/users/${second.id}`).set(auth(admin))).status).toBe(403);
    expect((await request(api).delete(`/api/v1/admin/users/${superAdmin.id}`).set(auth(admin))).status).toBe(
      403,
    );
    expect(
      (await request(api).delete(`/api/v1/admin/users/${superAdmin.id}`).set(auth(superAdmin))).status,
    ).toBe(400);

    expect((await request(api).delete(`/api/v1/admin/users/${second.id}`).set(auth(superAdmin))).status).toBe(
      200,
    );
    // The removed admin's token is now useless.
    expect((await request(api).get('/api/v1/admin/overview').set(auth(second))).status).toBe(401);
  });

  it('can be undone with reactivate', async () => {
    await request(api).delete(`/api/v1/admin/users/${mark.id}`).set(auth(admin));
    const res = await request(api).post(`/api/v1/admin/users/${mark.id}/reactivate`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');
    expect((await login(mark.email, PASSWORD)).status).toBe(200);
    expect(
      (await request(api).post(`/api/v1/admin/users/${mark.id}/reactivate`).set(auth(admin))).status,
    ).toBe(400);
  });
});

describe('POST /me/change-password', () => {
  it('checks the current password, then signs out other sessions', async () => {
    const session = await login(mark.email, PASSWORD);
    const wrong = await request(api)
      .post('/api/v1/me/change-password')
      .set(auth(mark))
      .send({ currentPassword: 'Wrong-pass-1', newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.fields[0].field).toBe('currentPassword');

    const res = await request(api)
      .post('/api/v1/me/change-password')
      .set(auth(mark))
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect((await login(mark.email, NEW_PASSWORD)).status).toBe(200);
    const refresh = await request(api)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.body.data.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('enforces the password rules', async () => {
    const res = await request(api)
      .post('/api/v1/me/change-password')
      .set(auth(mark))
      .send({ currentPassword: PASSWORD, newPassword: 'letters-only' });
    expect(res.status).toBe(400);
  });
});
