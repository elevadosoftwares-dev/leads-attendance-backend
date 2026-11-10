import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../src/db/pool';
import { AUTO_CLOCK_OUT_SUMMARY, runAutoClockOut } from '../src/jobs/autoClockOut.job';
import { runShiftReminder } from '../src/jobs/shiftReminder.job';
import { pushService, setMessagingClient } from '../src/services/push.service';
import { addDaysToWorkDate, combineWorkDateAndTime, todayWorkDate } from '../src/utils/time';
import {
  app,
  auth,
  createAttendance,
  createOffice,
  createUser,
  resetDb,
  scalar,
  type TestUser,
} from './helpers';

let officeId: number;
let admin: TestUser;
let mark: TestUser;
let john: TestUser;
const today = todayWorkDate();
const yesterday = addDaysToWorkDate(today, -1);

beforeEach(async () => {
  await resetDb();
  officeId = await createOffice();
  admin = await createUser(officeId, { role: 'ADMIN', name: 'Admin' });
  mark = await createUser(officeId, { name: 'Mark Tan' });
  john = await createUser(officeId, { name: 'John Lim' });
});

afterEach(() => {
  vi.restoreAllMocks();
  setMessagingClient(undefined);
});

afterAll(async () => {
  await closePool();
});

const registerDevice = (user: TestUser, fcmToken: string, silent?: boolean) =>
  request(app)
    .post('/api/v1/me/device-token')
    .set(auth(user))
    .send({ fcmToken, platform: 'android', silent });

function fakeMessaging(deadTokens: string[] = []) {
  const sendEachForMulticast = vi.fn(async (message: MulticastMessage): Promise<BatchResponse> => {
    const responses = message.tokens.map((token) =>
      deadTokens.includes(token)
        ? {
            success: false,
            error: { code: 'messaging/registration-token-not-registered', message: 'gone' },
          }
        : { success: true, messageId: `id-${token}` },
    );
    return {
      responses,
      successCount: responses.filter((r) => r.success).length,
      failureCount: responses.filter((r) => !r.success).length,
    } as BatchResponse;
  });
  setMessagingClient({ sendEachForMulticast });
  return sendEachForMulticast;
}

describe('push service', () => {
  it('sends to the users’ devices and deletes tokens FCM reports as unregistered', async () => {
    await registerDevice(mark, 'mark-device-token-0001');
    await registerDevice(mark, 'mark-device-token-dead');
    await registerDevice(john, 'john-device-token-0001');
    const send = fakeMessaging(['mark-device-token-dead']);

    await pushService.notifyUsers([mark.id], { title: 'Hello', body: 'World', data: { type: 'TEST' } });

    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0]![0];
    expect([...message.tokens].sort()).toEqual(['mark-device-token-0001', 'mark-device-token-dead']);
    expect(message.notification).toEqual({ title: 'Hello', body: 'World' });
    expect(message.data).toEqual({ type: 'TEST' });

    const remaining = await scalar<number>('SELECT COUNT(*) FROM dbo.DeviceTokens');
    expect(remaining).toBe(2);
    expect(
      await scalar<number>(
        "SELECT COUNT(*) FROM dbo.DeviceTokens WHERE FcmToken = N'mark-device-token-dead'",
      ),
    ).toBe(0);
  });

  it('sends to silent devices on the silent channel without sound', async () => {
    await registerDevice(mark, 'mark-device-token-0001');
    await registerDevice(mark, 'mark-device-token-mute', true);
    const send = fakeMessaging();

    await pushService.notifyUsers([mark.id], { title: 'New task assigned', body: 'Inspect hub' });

    expect(send).toHaveBeenCalledTimes(2);
    const [sound, silent] = send.mock.calls.map((c) => c[0]);
    expect(sound!.tokens).toEqual(['mark-device-token-0001']);
    expect(sound!.android?.notification).toMatchObject({ channelId: 'leads_default', defaultSound: true });
    expect(sound!.apns?.payload?.aps).toEqual({ sound: 'default' });
    expect(silent!.tokens).toEqual(['mark-device-token-mute']);
    expect(silent!.android?.notification).toMatchObject({ channelId: 'leads_silent', defaultSound: false });
    expect(silent!.apns?.payload?.aps).toEqual({});

    // Switching the setting off again re-registers the same token with sound.
    await registerDevice(mark, 'mark-device-token-mute', false);
    send.mockClear();
    await pushService.notifyUsers([mark.id], { title: 'Hi', body: 'There' });
    expect(send).toHaveBeenCalledOnce();
    expect([...send.mock.calls[0]![0].tokens].sort()).toEqual([
      'mark-device-token-0001',
      'mark-device-token-mute',
    ]);
  });

  it('broadcasts to all active users', async () => {
    await registerDevice(mark, 'mark-device-token-0001');
    await registerDevice(admin, 'admin-device-token-01');
    const inactive = await createUser(officeId, { name: 'Gone Away', isActive: false });
    await registerDevice(inactive, 'inactive-device-token');
    const send = fakeMessaging();

    await pushService.notifyAllActive({ title: 'Announcement', body: 'Body' });
    expect([...send.mock.calls[0]![0].tokens].sort()).toEqual([
      'admin-device-token-01',
      'mark-device-token-0001',
    ]);
  });

  it('never rejects, even when FCM fails', async () => {
    await registerDevice(mark, 'mark-device-token-0001');
    setMessagingClient({ sendEachForMulticast: vi.fn().mockRejectedValue(new Error('FCM down')) });
    await expect(pushService.notifyUsers([mark.id], { title: 't', body: 'b' })).resolves.toBeUndefined();
  });

  it('is a logged no-op without Firebase credentials', async () => {
    await registerDevice(mark, 'mark-device-token-0001');
    setMessagingClient(null);
    await expect(pushService.notifyUsers([mark.id], { title: 't', body: 'b' })).resolves.toBeUndefined();
  });

  it('does not fail the request when sending throws', async () => {
    setMessagingClient({ sendEachForMulticast: vi.fn().mockRejectedValue(new Error('FCM down')) });
    await registerDevice(mark, 'mark-device-token-0001');
    const res = await request(app).post('/api/v1/admin/tasks').set(auth(admin)).send({
      title: 'T',
      assigneeId: mark.id,
      priority: 'LOW',
      dueDate: today,
      dueTime: '17:00',
      notify: true,
    });
    expect(res.status).toBe(201);
  });
});

describe('shift reminder job', () => {
  it('reminds employees who have not clocked in and are not on leave', async () => {
    const sarah = await createUser(officeId, { name: 'Sarah Lee' });
    await createAttendance({ userId: john.id, workDate: today, clockInUtc: new Date(Date.now() - 60_000) });
    await request(app)
      .post('/api/v1/admin/leaves')
      .set(auth(admin))
      .send({ userId: sarah.id, fromDate: today, toDate: today, reason: 'MC' });
    const spy = vi.spyOn(pushService, 'notifyUsers').mockResolvedValue();

    const reminded = await runShiftReminder();
    expect(reminded).toEqual([mark.id]);
    expect(spy).toHaveBeenCalledWith(
      [mark.id],
      expect.objectContaining({ data: { type: 'SHIFT_REMINDER' } }),
    );
  });
});

describe('auto clock-out job', () => {
  it('closes open shifts at 23:59 SG with a placeholder report', async () => {
    const markShift = await createAttendance({
      userId: mark.id,
      workDate: yesterday,
      clockInUtc: combineWorkDateAndTime(yesterday, '09:00'),
    });
    const johnShift = await createAttendance({
      userId: john.id,
      workDate: today,
      clockInUtc: combineWorkDateAndTime(today, '00:01'),
    });

    // Run "now" (before 23:59 today): only yesterday's shift is past its cutoff.
    const beforeMidnight = combineWorkDateAndTime(today, '23:00');
    expect(await runAutoClockOut(beforeMidnight)).toEqual([markShift]);

    const clockOut = await scalar<Date>(
      'SELECT ClockOutUtc FROM dbo.Attendance WHERE AttendanceId = @id',
      (r) => r.input('id', markShift),
    );
    expect(clockOut.toISOString()).toBe(combineWorkDateAndTime(yesterday, '23:59').toISOString());
    expect(
      await scalar<string>('SELECT Summary FROM dbo.DailyReports WHERE AttendanceId = @id', (r) =>
        r.input('id', markShift),
      ),
    ).toBe(AUTO_CLOCK_OUT_SUMMARY);

    // At 23:59 today, today's shift closes too.
    expect(await runAutoClockOut(combineWorkDateAndTime(today, '23:59'))).toEqual([johnShift]);
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.Attendance WHERE ClockOutUtc IS NULL')).toBe(0);
    expect(await scalar<number>('SELECT COUNT(*) FROM dbo.DailyReports')).toBe(2);

    // Idempotent.
    expect(await runAutoClockOut(combineWorkDateAndTime(today, '23:59'))).toEqual([]);
  });
});
