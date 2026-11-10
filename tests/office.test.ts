import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { loadCompanyTimezone } from '../src/modules/offices/offices.service';
import {
  addDaysToWorkDate,
  combineWorkDateAndTime,
  companyTimezone,
  setCompanyTimezone,
  todayWorkDate,
} from '../src/utils/time';
import { OFFICE, app, auth, createOffice, createUser, resetDb, scalar, type TestUser } from './helpers';

let officeId: number;
let superAdmin: TestUser;
let admin: TestUser;
let mark: TestUser;
const yesterday = addDaysToWorkDate(todayWorkDate(), -1);

beforeEach(async () => {
  await resetDb();
  officeId = await createOffice();
  superAdmin = await createUser(officeId, { role: 'SUPER_ADMIN', name: 'Super Admin' });
  admin = await createUser(officeId, { role: 'ADMIN', name: 'Admin' });
  mark = await createUser(officeId, { name: 'Mark Tan', shiftStart: '08:30' });
});

afterAll(async () => {
  await closePool();
});

const getOffice = (user: TestUser) => request(app).get('/api/v1/admin/office').set(auth(user));
const patchOffice = (user: TestUser, body: object) =>
  request(app).patch('/api/v1/admin/office').set(auth(user)).send(body);

describe('GET /admin/office', () => {
  it('shows location, geofence and working time to any admin', async () => {
    const res = await getOffice(admin);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: officeId,
      name: 'LEADS Office Geofence',
      address: '123 Aerospace Tech Park, Singapore',
      latitude: OFFICE.lat,
      longitude: OFFICE.lng,
      radiusMeters: OFFICE.radius,
      defaultShiftStart: '09:00',
      defaultShiftEnd: '18:00',
      lateGraceMinutes: 10,
      timezone: 'Asia/Singapore',
      updatedUtc: expect.stringMatching(/Z$/),
    });
  });

  it('is not available to employees', async () => {
    expect((await getOffice(mark)).status).toBe(403);
  });
});

describe('PATCH /admin/office', () => {
  it('is super admin only', async () => {
    for (const user of [admin, mark]) {
      const res = await patchOffice(user, { radiusMeters: 300 });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect((await getOffice(admin)).body.data.radiusMeters).toBe(OFFICE.radius);
  });

  it('updates location, geofence and working time', async () => {
    const res = await patchOffice(superAdmin, {
      name: 'LEADS Seletar',
      address: '1 Seletar Aerospace Drive',
      latitude: 1.4105,
      longitude: 103.8695,
      radiusMeters: 250,
      defaultShiftStart: '08:00',
      lateGraceMinutes: 15,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'LEADS Seletar',
      address: '1 Seletar Aerospace Drive',
      latitude: 1.4105,
      longitude: 103.8695,
      radiusMeters: 250,
      defaultShiftStart: '08:00',
      lateGraceMinutes: 15,
    });
    // Existing shift starts are untouched unless asked.
    expect(
      await scalar<string>(
        'SELECT CONVERT(CHAR(5), ShiftStart, 108) FROM dbo.Users WHERE UserId = @id',
        (r) => r.input('id', mark.id),
      ),
    ).toBe('08:30');
  });

  it('can move every user to the new shift', async () => {
    const res = await patchOffice(superAdmin, {
      defaultShiftStart: '07:45',
      defaultShiftEnd: '16:45',
      applyShiftToAllUsers: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ defaultShiftStart: '07:45', defaultShiftEnd: '16:45' });
    const shifts = await scalar<number>(
      `SELECT COUNT(*) FROM dbo.Users
        WHERE CONVERT(CHAR(5), ShiftStart, 108) <> '07:45' OR CONVERT(CHAR(5), ShiftEnd, 108) <> '16:45'`,
    );
    expect(shifts).toBe(0);
  });

  it('moving only the end also gives everyone the default start', async () => {
    await patchOffice(superAdmin, { defaultShiftEnd: '17:30', applyShiftToAllUsers: true });
    const res = await request(app).get('/api/v1/admin/users').set(auth(admin));
    const markRow = res.body.data.find((u: { id: number }) => u.id === mark.id);
    expect(markRow).toMatchObject({ shiftStart: '09:00', shiftEnd: '17:30' });
  });

  it('keeps the shift end after the start', async () => {
    const early = await patchOffice(superAdmin, { defaultShiftEnd: '08:00' });
    expect(early.status).toBe(400);
    expect(early.body.error.details.fields[0].field).toBe('defaultShiftEnd');
    expect((await patchOffice(superAdmin, { defaultShiftStart: '18:00' })).status).toBe(400);
    expect(
      (await patchOffice(superAdmin, { defaultShiftStart: '10:00', defaultShiftEnd: '19:00' })).status,
    ).toBe(200);
  });

  it('gives new sign-ups the default shift', async () => {
    await patchOffice(superAdmin, { defaultShiftStart: '10:15', defaultShiftEnd: '19:15' });
    const signup = await request(app)
      .post('/api/v1/auth/signup')
      .send({ name: 'Jane Lim', email: 'jane@leads-ndt.com', password: 'Welcome123' });
    expect(signup.status).toBe(201);
    const approved = await request(app)
      .post(`/api/v1/admin/users/${signup.body.data.id}/approve`)
      .set(auth(admin))
      .send({});
    expect(approved.body.data).toMatchObject({ shiftStart: '10:15', shiftEnd: '19:15' });
  });

  it('uses the grace minutes to decide lateness', async () => {
    const manual = (userId: number) =>
      request(app)
        .post('/api/v1/admin/attendance/manual')
        .set(auth(admin))
        .send({
          userId,
          workDate: yesterday,
          // 20 minutes after mark's 08:30 shift start.
          clockInUtc: combineWorkDateAndTime(yesterday, '08:50').toISOString(),
          clockOutUtc: combineWorkDateAndTime(yesterday, '17:30').toISOString(),
          reason: 'Phone battery died',
        });

    expect((await manual(mark.id)).body.data.isLate).toBe(true); // grace 10
    await patchOffice(superAdmin, { lateGraceMinutes: 30 });
    const john = await createUser(officeId, { name: 'John Lim', shiftStart: '08:30' });
    expect((await manual(john.id)).body.data.isLate).toBe(false);
  });

  it('validates the body', async () => {
    expect((await patchOffice(superAdmin, {})).status).toBe(400);
    expect((await patchOffice(superAdmin, { radiusMeters: 0 })).status).toBe(400);
    expect((await patchOffice(superAdmin, { latitude: 95 })).status).toBe(400);
    expect((await patchOffice(superAdmin, { defaultShiftStart: '25:00' })).status).toBe(400);
    expect((await patchOffice(superAdmin, { lateGraceMinutes: -1 })).status).toBe(400);
    expect((await patchOffice(superAdmin, { applyShiftToAllUsers: true })).status).toBe(400);
    expect((await patchOffice(superAdmin, { defaultShiftEnd: '24:00' })).status).toBe(400);
    expect((await patchOffice(superAdmin, { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await patchOffice(superAdmin, { timezone: '' })).status).toBe(400);
  });
});

describe('company timezone', () => {
  afterEach(() => setCompanyTimezone('Asia/Singapore'));

  it('is set by the super admin and applies at once', async () => {
    const res = await patchOffice(superAdmin, { timezone: 'Asia/Kolkata' });
    expect(res.status).toBe(200);
    expect(res.body.data.timezone).toBe('Asia/Kolkata');
    expect(companyTimezone()).toBe('Asia/Kolkata');
    expect(
      await scalar<string>('SELECT Timezone FROM dbo.Offices WHERE OfficeId = @id', (r) =>
        r.input('id', officeId),
      ),
    ).toBe('Asia/Kolkata');
    // Apps read it from the profile.
    const me = await request(app).get('/api/v1/me').set(auth(mark));
    expect(me.body.data.timezone).toBe('Asia/Kolkata');
  });

  it('decides work dates and lateness', async () => {
    await patchOffice(superAdmin, { timezone: 'Asia/Kolkata' });
    // 08:50 in Kolkata is 11:20 in Singapore: on time against the 08:30 shift in Singapore, late in Kolkata.
    const res = await request(app)
      .post('/api/v1/admin/attendance/manual')
      .set(auth(admin))
      .send({
        userId: mark.id,
        workDate: yesterday,
        clockInUtc: combineWorkDateAndTime(yesterday, '08:50', 'Asia/Kolkata').toISOString(),
        clockOutUtc: combineWorkDateAndTime(yesterday, '17:30', 'Asia/Kolkata').toISOString(),
        reason: 'Phone battery died',
      });
    expect(res.body.data.isLate).toBe(true);
    expect(todayWorkDate()).toBe(todayWorkDate('Asia/Kolkata'));
  });

  it('is only changed by the super admin', async () => {
    expect((await patchOffice(admin, { timezone: 'Asia/Kolkata' })).status).toBe(403);
    expect(companyTimezone()).toBe('Asia/Singapore');
  });

  it('is loaded from the office at startup', async () => {
    await scalar("UPDATE dbo.Offices SET Timezone = N'Asia/Dubai'; SELECT 1");
    expect(await loadCompanyTimezone()).toBe('Asia/Dubai');
  });
});

describe('super admin', () => {
  it('can use every admin endpoint and the live dashboard data', async () => {
    expect((await request(app).get('/api/v1/admin/overview').set(auth(superAdmin))).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/users').set(auth(superAdmin))).status).toBe(200);
  });

  it('is not an employee (no clock-in)', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/clock-in')
      .set(auth(superAdmin))
      .send({ latitude: OFFICE.lat, longitude: OFFICE.lng, accuracy: 5, isMocked: false });
    expect(res.status).toBe(403);
  });
});
