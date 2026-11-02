import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { closePool } from '../src/db/pool';
import { mailService } from '../src/services/mail.service';
import { PASSWORD, auth, createOffice, createUser, resetDb, scalar, type TestUser } from './helpers';

let officeId: number;
let mark: TestUser;
// A fresh app per test, so the login rate limiter starts empty.
let api: ReturnType<typeof createApp>;

beforeEach(async () => {
  api = createApp();
  await resetDb();
  officeId = await createOffice();
  mark = await createUser(officeId, { name: 'Mark Tan', email: 'mark.tan@leads-ndt.com' });
});

afterAll(async () => {
  await closePool();
});

const login = (email: string, password: string, target = api) =>
  request(target).post('/api/v1/auth/login').send({ email, password });

describe('POST /auth/login', () => {
  it('returns tokens and the user', async () => {
    const res = await login('mark.tan@leads-ndt.com', PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: {
        id: mark.id,
        name: 'Mark Tan',
        email: 'mark.tan@leads-ndt.com',
        role: 'EMPLOYEE',
        initials: 'MT',
        shiftStart: '09:00',
        officeId,
      },
    });
    const payload = jwt.decode(res.body.data.accessToken) as Record<string, unknown>;
    expect(payload.sub).toBe(String(mark.id));
    expect(payload.role).toBe('EMPLOYEE');
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'role', 'sub']);
  });

  it('treats the email case-insensitively', async () => {
    const res = await login('  Mark.Tan@LEADS-ndt.com ', PASSWORD);
    expect(res.status).toBe(200);
  });

  it('returns the same INVALID_CREDENTIALS error for a wrong password and an unknown email', async () => {
    const wrong = await login('mark.tan@leads-ndt.com', 'nope-nope');
    const unknown = await login('nobody@leads-ndt.com', 'nope-nope');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects inactive users', async () => {
    const inactive = await createUser(officeId, { email: 'gone@leads-ndt.com', isActive: false });
    const res = await login(inactive.email, PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('validates the body', async () => {
    const res = await request(api).post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.fields.map((f: { field: string }) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('rate limits after 5 attempts per IP and email', async () => {
    const fresh = createApp();
    for (let i = 0; i < 5; i++) {
      const res = await login('mark.tan@leads-ndt.com', 'wrong-password', fresh);
      expect(res.status).toBe(401);
    }
    const blocked = await login('mark.tan@leads-ndt.com', PASSWORD, fresh);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // A different email from the same IP has its own budget.
    const other = await login('someone.else@leads-ndt.com', 'x', fresh);
    expect(other.status).toBe(401);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token and detects reuse', async () => {
    const first = (await login(mark.email, PASSWORD)).body.data;

    const rotated = await request(api)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.data).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String) });
    expect(rotated.body.data.refreshToken).not.toBe(first.refreshToken);

    // Replaying the old token revokes every token the user holds, including the newly issued one.
    const replay = await request(api).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('UNAUTHORIZED');

    const afterReplay = await request(api)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotated.body.data.refreshToken });
    expect(afterReplay.status).toBe(401);
  });

  it('rejects unknown tokens', async () => {
    const res = await request(api).post('/api/v1/auth/refresh').send({ refreshToken: 'garbage' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('stores only token hashes', async () => {
    const { refreshToken } = (await login(mark.email, PASSWORD)).body.data;
    const stored = await scalar<number>('SELECT COUNT(*) FROM dbo.RefreshTokens WHERE TokenHash = @t', (r) =>
      r.input('t', refreshToken),
    );
    expect(stored).toBe(0);
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.RefreshTokens')).toBe(1);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the refresh token', async () => {
    const { accessToken, refreshToken } = (await login(mark.email, PASSWORD)).body.data;
    const res = await request(api)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: {} });

    const again = await request(api).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(again.status).toBe(401);
  });

  it('requires authentication', async () => {
    const res = await request(api).post('/api/v1/auth/logout').send({ refreshToken: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('password reset', () => {
  it('always returns 200 and never reveals whether the email exists', async () => {
    const spy = vi.spyOn(mailService, 'sendPasswordReset').mockResolvedValue();
    const unknown = await request(api)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@leads-ndt.com' });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ success: true, data: {} });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('resets the password with a single-use token and signs out other sessions', async () => {
    const spy = vi.spyOn(mailService, 'sendPasswordReset').mockResolvedValue();
    const session = (await login(mark.email, PASSWORD)).body.data;

    const res = await request(api).post('/api/v1/auth/forgot-password').send({ email: mark.email });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    const link = new URL(spy.mock.calls[0]![2]);
    const token = link.searchParams.get('token')!;
    expect(token.length).toBeGreaterThan(20);
    spy.mockRestore();

    const reset = await request(api)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'NewPassw0rd' });
    expect(reset.status).toBe(200);

    expect((await login(mark.email, PASSWORD)).status).toBe(401);
    expect((await login(mark.email, 'NewPassw0rd')).status).toBe(200);

    const reuse = await request(api)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'Another1pass' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('VALIDATION_ERROR');

    const oldSession = await request(api)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken });
    expect(oldSession.status).toBe(401);
  });

  it('rejects weak passwords', async () => {
    const res = await request(api)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'abc', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /me', () => {
  it('returns the current user', async () => {
    const res = await request(api).get('/api/v1/me').set(auth(mark));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: mark.id, name: 'Mark Tan', initials: 'MT', role: 'EMPLOYEE' });
  });

  it('returns UNAUTHORIZED without a token', async () => {
    const res = await request(api).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns UNAUTHORIZED for a forged token', async () => {
    const forged = jwt.sign({ role: 'ADMIN' }, 'not-the-real-secret-not-the-real-secret', {
      subject: String(mark.id),
    });
    const res = await request(api).get('/api/v1/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns TOKEN_EXPIRED for an expired token', async () => {
    const expired = jwt.sign({ role: 'EMPLOYEE' }, env.JWT_ACCESS_SECRET, {
      subject: String(mark.id),
      expiresIn: -10,
    });
    const res = await request(api).get('/api/v1/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });
});

describe('POST /me/device-token', () => {
  it('upserts the FCM token and reassigns it between users', async () => {
    const body = { fcmToken: 'fcm-token-abcdefghijklmnop', platform: 'android' };
    expect((await request(api).post('/api/v1/me/device-token').set(auth(mark)).send(body)).status).toBe(200);
    expect((await request(api).post('/api/v1/me/device-token').set(auth(mark)).send(body)).status).toBe(200);
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.DeviceTokens')).toBe(1);

    const john = await createUser(officeId, { name: 'John Lim' });
    await request(api)
      .post('/api/v1/me/device-token')
      .set(auth(john))
      .send({ ...body, platform: 'ios' });
    expect(await scalar<number>('SELECT UserId FROM dbo.DeviceTokens')).toBe(john.id);
  });

  it('validates the platform', async () => {
    const res = await request(api)
      .post('/api/v1/me/device-token')
      .set(auth(mark))
      .send({ fcmToken: 'fcm-token-abcdefghijklmnop', platform: 'windows' });
    expect(res.status).toBe(400);
  });
});
