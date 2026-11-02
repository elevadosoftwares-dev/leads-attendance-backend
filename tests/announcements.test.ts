import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../src/db/pool';
import { pushService } from '../src/services/push.service';
import { app, auth, createOffice, createUser, resetDb, type TestUser } from './helpers';

let admin: TestUser;
let mark: TestUser;

beforeEach(async () => {
  await resetDb();
  const officeId = await createOffice();
  admin = await createUser(officeId, { role: 'ADMIN', name: 'Admin' });
  mark = await createUser(officeId, { name: 'Mark Tan' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

const create = (body: object, user: TestUser = admin) =>
  request(app)
    .post('/api/v1/admin/announcements')
    .set(auth(user))
    .send({ title: 'Notice', body: 'Details', category: 'GENERAL', isPinned: false, notify: false, ...body });

describe('admin announcements', () => {
  it('creates an announcement', async () => {
    const res = await create({ title: 'Safety Briefing Tomorrow', category: 'SAFETY', isPinned: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      title: 'Safety Briefing Tomorrow',
      body: 'Details',
      category: 'SAFETY',
      isPinned: true,
      createdUtc: expect.stringMatching(/Z$/),
      author: { id: admin.id, name: 'Admin' },
    });
  });

  it('notifies all active users only when notify=true', async () => {
    const spy = vi.spyOn(pushService, 'notifyAllActive').mockResolvedValue();
    await create({ notify: false });
    expect(spy).not.toHaveBeenCalled();
    await create({ title: 'Family Day', notify: true, category: 'EVENTS' });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toMatchObject({ title: 'Family Day', data: { type: 'ANNOUNCEMENT' } });
  });

  it('validates the category and requires admin', async () => {
    expect((await create({ category: 'PARTY' })).status).toBe(400);
    expect((await create({ title: '  ' })).status).toBe(400);
    expect((await create({}, mark)).status).toBe(403);
  });

  it('patches and soft-deletes', async () => {
    const id = (await create({})).body.data.id;
    const patched = await request(app)
      .patch(`/api/v1/admin/announcements/${id}`)
      .set(auth(admin))
      .send({ isPinned: true, title: 'Updated' });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ isPinned: true, title: 'Updated', body: 'Details' });

    const del = await request(app).delete(`/api/v1/admin/announcements/${id}`).set(auth(admin));
    expect(del.body).toEqual({ success: true, data: {} });

    expect((await request(app).get(`/api/v1/announcements/${id}`).set(auth(mark))).status).toBe(404);
    expect((await request(app).delete(`/api/v1/admin/announcements/${id}`).set(auth(admin))).status).toBe(
      404,
    );
    expect(
      (await request(app).patch(`/api/v1/admin/announcements/${id}`).set(auth(admin)).send({ title: 'x' }))
        .status,
    ).toBe(404);
  });
});

describe('GET /announcements', () => {
  it('returns pinned separately and paginates the rest, newest first', async () => {
    await create({ title: 'Pinned safety', category: 'SAFETY', isPinned: true });
    for (let i = 1; i <= 5; i++) await create({ title: `General ${i}` });
    await create({ title: 'Event', category: 'EVENTS' });
    const deleted = (await create({ title: 'Deleted' })).body.data.id;
    await request(app).delete(`/api/v1/admin/announcements/${deleted}`).set(auth(admin));

    const page1 = await request(app).get('/api/v1/announcements?page=1&pageSize=4').set(auth(mark));
    expect(page1.status).toBe(200);
    expect(page1.body.data.pinned.map((a: { title: string }) => a.title)).toEqual(['Pinned safety']);
    expect(page1.body.data).toMatchObject({ page: 1, pageSize: 4, total: 6 });
    expect(page1.body.data.items.map((a: { title: string }) => a.title)).toEqual([
      'Event',
      'General 5',
      'General 4',
      'General 3',
    ]);

    const page2 = await request(app).get('/api/v1/announcements?page=2&pageSize=4').set(auth(mark));
    expect(page2.body.data.items.map((a: { title: string }) => a.title)).toEqual(['General 2', 'General 1']);
  });

  it('filters by category (pinned included), and an empty category means all', async () => {
    await create({ title: 'Pinned safety', category: 'SAFETY', isPinned: true });
    await create({ title: 'Safety 2', category: 'SAFETY' });
    await create({ title: 'General' });

    const safety = await request(app).get('/api/v1/announcements?category=SAFETY').set(auth(mark));
    expect(safety.body.data.pinned).toHaveLength(1);
    expect(safety.body.data.total).toBe(1);

    const general = await request(app).get('/api/v1/announcements?category=GENERAL').set(auth(mark));
    expect(general.body.data.pinned).toHaveLength(0);
    expect(general.body.data.total).toBe(1);

    const all = await request(app).get('/api/v1/announcements?category=').set(auth(mark));
    expect(all.body.data.total).toBe(2);

    expect((await request(app).get('/api/v1/announcements?category=NOPE').set(auth(mark))).status).toBe(400);
  });

  it('requires authentication and returns a single announcement', async () => {
    const id = (await create({ title: 'One' })).body.data.id;
    expect((await request(app).get('/api/v1/announcements')).status).toBe(401);
    const one = await request(app).get(`/api/v1/announcements/${id}`).set(auth(admin));
    expect(one.body.data.title).toBe('One');
  });
});
