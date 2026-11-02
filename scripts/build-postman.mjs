/* eslint-disable no-console */
// Generates docs/postman/LEADS-Attendance.postman_collection.json.
//   node scripts/build-postman.mjs
// Run it against freshly seeded data (npm run seed) with the Postman CLI:
//   postman collection run docs/postman/LEADS-Attendance.postman_collection.json --working-dir .
import fs from 'node:fs';

const json = (value) => JSON.stringify(value, null, 2);
const lines = (src) => src.trim().split('\n');

/** A request item. `auth`: 'employee' | 'admin' | 'none'. */
function req(
  name,
  method,
  path,
  { auth = 'employee', body, formFile, query, test, prerequest, description } = {},
) {
  const [rawPath, rawQuery] = path.split('?');
  const queryPairs = query ?? (rawQuery ? rawQuery.split('&').map((p) => p.split('=')) : []);
  const item = {
    name,
    request: {
      method,
      header: [],
      url: {
        raw: `{{baseUrl}}${path}`,
        host: ['{{baseUrl}}'],
        path: rawPath.split('/').filter(Boolean),
        ...(queryPairs.length ? { query: queryPairs.map(([key, value]) => ({ key, value })) } : {}),
      },
      auth:
        auth === 'none'
          ? { type: 'noauth' }
          : {
              type: 'bearer',
              bearer: [
                {
                  key: 'token',
                  value: auth === 'admin' ? '{{adminToken}}' : '{{accessToken}}',
                  type: 'string',
                },
              ],
            },
      ...(description ? { description } : {}),
    },
    event: [],
  };
  if (body !== undefined) {
    item.request.header.push({ key: 'Content-Type', value: 'application/json' });
    item.request.body = {
      mode: 'raw',
      raw: typeof body === 'string' ? body : json(body),
      options: { raw: { language: 'json' } },
    };
  }
  if (formFile) {
    item.request.body = { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: formFile }] };
  }
  if (prerequest)
    item.event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: lines(prerequest) } });
  if (test) item.event.push({ listen: 'test', script: { type: 'text/javascript', exec: lines(test) } });
  return item;
}

const expectStatus = (codes) => `
pm.test('status is ${[codes].flat().join(' or ')}', () => pm.expect(${json([codes].flat())}).to.include(pm.response.code));
`;
const envelopeOk = `
pm.test('success envelope', () => pm.expect(pm.response.json().success).to.eql(true));
`;
const errorCode = (code) => `
pm.test('error code ${code}', () => pm.expect(pm.response.json().error.code).to.eql('${code}'));
`;

const OFFICE_FIX = { latitude: 1.417, longitude: 103.868, accuracy: 10, isMocked: false };

const collection = {
  info: {
    name: 'LEADS Attendance API',
    description:
      'All endpoints of the LEADS Attendance backend. Run "npm run seed" first; the folders are ordered so the whole ' +
      'collection runs top to bottom (log in → employee day → admin → auth housekeeping).\n\n' +
      'Seeded logins (password Leads@123): admin@leads-ndt.com, mark.tan@leads-ndt.com, john.lim@leads-ndt.com, sarah.lee@leads-ndt.com.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:4000/api/v1' },
    { key: 'password', value: 'Leads@123' },
    { key: 'adminEmail', value: 'admin@leads-ndt.com' },
    { key: 'employeeEmail', value: 'mark.tan@leads-ndt.com' },
    { key: 'accessToken', value: '' },
    { key: 'refreshToken', value: '' },
    { key: 'adminToken', value: '' },
    { key: 'today', value: '' },
  ],
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: lines(`
// Today's work date in Asia/Singapore (UTC+8, no DST).
const sg = new Date(Date.now() + 8 * 3600 * 1000);
pm.collectionVariables.set('today', sg.toISOString().slice(0, 10));
`),
      },
    },
  ],
  item: [
    {
      name: '0. Health',
      item: [req('Health check', 'GET', '/health', { auth: 'none', test: expectStatus(200) + envelopeOk })],
    },
    {
      name: '1. Auth',
      item: [
        req('Login (employee)', 'POST', '/auth/login', {
          auth: 'none',
          body: '{\n  "email": "{{employeeEmail}}",\n  "password": "{{password}}"\n}',
          test:
            expectStatus(200) +
            envelopeOk +
            `
const data = pm.response.json().data;
pm.test('returns tokens and user', () => {
  pm.expect(data.accessToken).to.be.a('string');
  pm.expect(data.user.role).to.eql('EMPLOYEE');
});
pm.collectionVariables.set('accessToken', data.accessToken);
pm.collectionVariables.set('refreshToken', data.refreshToken);
`,
        }),
        req('Login (admin)', 'POST', '/auth/login', {
          auth: 'none',
          body: '{\n  "email": "{{adminEmail}}",\n  "password": "{{password}}"\n}',
          test:
            expectStatus(200) +
            `
pm.collectionVariables.set('adminToken', pm.response.json().data.accessToken);
pm.test('admin role', () => pm.expect(pm.response.json().data.user.role).to.eql('ADMIN'));
`,
        }),
        req('Login (wrong password)', 'POST', '/auth/login', {
          auth: 'none',
          body: { email: 'nobody@leads-ndt.com', password: 'wrong-password' },
          test: expectStatus(401) + errorCode('INVALID_CREDENTIALS'),
        }),
        req('Refresh tokens (rotates)', 'POST', '/auth/refresh', {
          auth: 'none',
          body: '{\n  "refreshToken": "{{refreshToken}}"\n}',
          test:
            expectStatus(200) +
            `
const data = pm.response.json().data;
pm.test('rotated', () => pm.expect(data.refreshToken).to.not.eql(pm.collectionVariables.get('refreshToken')));
pm.collectionVariables.set('accessToken', data.accessToken);
pm.collectionVariables.set('refreshToken', data.refreshToken);
`,
        }),
        req('Forgot password', 'POST', '/auth/forgot-password', {
          auth: 'none',
          body: { email: 'john.lim@leads-ndt.com' },
          description: 'Always 200. Without SMTP the reset link is printed in the server log.',
          test: expectStatus(200),
        }),
        req('Reset password (invalid token)', 'POST', '/auth/reset-password', {
          auth: 'none',
          body: { token: 'paste-token-from-reset-link', newPassword: 'NewPassw0rd' },
          test: expectStatus(400) + errorCode('VALIDATION_ERROR'),
        }),
      ],
    },
    {
      name: '2. Employee',
      item: [
        req('Me', 'GET', '/me', { test: expectStatus(200) + envelopeOk }),
        req('Register device token', 'POST', '/me/device-token', {
          body: { fcmToken: 'postman-demo-fcm-token-0001', platform: 'android' },
          test: expectStatus(200),
        }),
        req('Today (home)', 'GET', '/me/today', {
          test:
            expectStatus(200) +
            `
const d = pm.response.json().data;
pm.test('has office and attendance status', () => {
  pm.expect(d.office.radiusMeters).to.be.a('number');
  pm.expect(['NOT_CLOCKED_IN', 'CLOCKED_IN', 'CLOCKED_OUT']).to.include(d.attendance.status);
});
`,
        }),
        req('Clock in (outside geofence → 422)', 'POST', '/attendance/clock-in', {
          body: { latitude: 1.43, longitude: 103.868, accuracy: 10, isMocked: false },
          test: expectStatus(422) + errorCode('OUTSIDE_GEOFENCE'),
        }),
        req('Clock in (mocked → 422)', 'POST', '/attendance/clock-in', {
          body: { ...OFFICE_FIX, isMocked: true },
          test: expectStatus(422) + errorCode('MOCK_LOCATION'),
        }),
        req('Clock in', 'POST', '/attendance/clock-in', {
          body: OFFICE_FIX,
          description:
            'Inside the seeded office geofence. 409 ALREADY_CLOCKED_IN if already clocked in or done today.',
          test:
            expectStatus([201, 409]) +
            `
if (pm.response.code === 201) {
  pm.test('geofence method', () => pm.expect(pm.response.json().data.method).to.eql('GEOFENCE'));
}
`,
        }),
        req('Current shift (daily report screen)', 'GET', '/attendance/current', {
          test:
            expectStatus([200, 404]) +
            `
if (pm.response.code === 200) {
  const todo = pm.response.json().data.tasks.find((t) => t.status === 'TODO' || t.status === 'CARRIED_OVER');
  pm.collectionVariables.set('carryTaskIds', todo ? JSON.stringify([todo.id]) : '[]');
}
`,
        }),
        req('Tasks for today', 'GET', '/tasks?date={{today}}', {
          test:
            expectStatus(200) +
            `
const items = pm.response.json().data.items;
pm.test('has tasks', () => pm.expect(items.length).to.be.above(0));
const inProgress = items.find((t) => t.status === 'IN_PROGRESS') || items.find((t) => t.status === 'TODO');
pm.collectionVariables.set('taskId', (inProgress || items[0]).id);
`,
        }),
        req('Task detail', 'GET', '/tasks/{{taskId}}', { test: expectStatus(200) + envelopeOk }),
        req('Start / complete task', 'PATCH', '/tasks/{{taskId}}/status', {
          prerequest: `
// Choose the next valid status from the task's current one.
pm.sendRequest({
  url: pm.collectionVariables.get('baseUrl') + '/tasks/' + pm.collectionVariables.get('taskId'),
  header: { Authorization: 'Bearer ' + pm.collectionVariables.get('accessToken') },
}, (err, res) => {
  const status = res.json().data.status;
  pm.collectionVariables.set('nextStatus', status === 'IN_PROGRESS' ? 'COMPLETED' : 'IN_PROGRESS');
});
`,
          body: '{\n  "status": "{{nextStatus}}"\n}',
          test: expectStatus([200, 400]),
        }),
        req('Upload attachment', 'POST', '/tasks/{{taskId}}/attachments', {
          formFile: 'docs/postman/sample-report.pdf',
          test:
            expectStatus(201) +
            `
pm.collectionVariables.set('attachmentId', pm.response.json().data.id);
`,
        }),
        req('Download attachment', 'GET', '/files/{{attachmentId}}', {
          test: `
pm.test('status is 200', () => pm.response.to.have.status(200));
pm.test('is a pdf', () => pm.expect(pm.response.headers.get('Content-Type')).to.include('application/pdf'));
`,
        }),
        req('Clock out with daily report', 'POST', '/attendance/clock-out', {
          body:
            '{\n  "latitude": 1.417,\n  "longitude": 103.868,\n  "accuracy": 12,\n  "isMocked": false,\n' +
            '  "summary": "Completed UT inspection on A320 MLG; report uploaded.",\n  "blockers": null,\n' +
            '  "notes": "Will finish the WO report tomorrow.",\n  "carryOverTaskIds": {{carryTaskIds}}\n}',
          prerequest: `
if (!pm.collectionVariables.get('carryTaskIds')) pm.collectionVariables.set('carryTaskIds', '[]');
`,
          test: expectStatus([200, 404]),
        }),
        req('Attendance history (this month)', 'GET', '/attendance/history', {
          test:
            expectStatus(200) +
            `
pm.test('has stats', () => pm.expect(pm.response.json().data.stats).to.have.keys('avgMinutes', 'taskCompletionRate'));
`,
        }),
      ],
    },
    {
      name: '3. Announcements',
      item: [
        req('List announcements', 'GET', '/announcements?page=1&pageSize=20', {
          test:
            expectStatus(200) +
            `
const d = pm.response.json().data;
pm.test('pinned + items', () => { pm.expect(d.pinned).to.be.an('array'); pm.expect(d.items).to.be.an('array'); });
const first = d.pinned[0] || d.items[0];
if (first) pm.collectionVariables.set('announcementId', first.id);
`,
        }),
        req('List SAFETY announcements', 'GET', '/announcements?category=SAFETY', {
          test: expectStatus(200),
        }),
        req('Get announcement', 'GET', '/announcements/{{announcementId}}', { test: expectStatus(200) }),
      ],
    },
    {
      name: '4. Admin',
      item: [
        req('Overview', 'GET', '/admin/overview', {
          auth: 'admin',
          test:
            expectStatus(200) +
            `
pm.test('overview shape', () => pm.expect(pm.response.json().data).to.include.keys('totalEmployees', 'inOffice', 'late', 'taskCompletionDeltaPct'));
`,
        }),
        req('Live attendance', 'GET', '/admin/attendance/live', { auth: 'admin', test: expectStatus(200) }),
        req('Employees (assignee dropdown)', 'GET', '/admin/users?role=EMPLOYEE', {
          auth: 'admin',
          test:
            expectStatus(200) +
            `
const users = pm.response.json().data;
pm.collectionVariables.set('assigneeId', users[0].id);
pm.collectionVariables.set('leaveUserId', users[users.length - 1].id);
`,
        }),
        req('Employee calling admin route → 403', 'GET', '/admin/overview', {
          test: expectStatus(403) + errorCode('FORBIDDEN'),
        }),
        req('Create task', 'POST', '/admin/tasks', {
          auth: 'admin',
          body:
            '{\n  "title": "Client follow-up: SIA Engineering",\n  "description": "Confirm next week\'s inspection slots.",\n' +
            '  "assigneeId": {{assigneeId}},\n  "priority": "HIGH",\n  "dueDate": "{{today}}",\n  "dueTime": "17:00",\n  "notify": true\n}',
          test:
            expectStatus(201) +
            `
pm.collectionVariables.set('adminTaskId', pm.response.json().data.id);
`,
        }),
        req('List tasks (paginated)', 'GET', '/admin/tasks?status=TODO&page=1&pageSize=20', {
          auth: 'admin',
          test: expectStatus(200),
        }),
        req('Task stats', 'GET', '/admin/tasks/stats', { auth: 'admin', test: expectStatus(200) }),
        req('Update task', 'PATCH', '/admin/tasks/{{adminTaskId}}', {
          auth: 'admin',
          body: { priority: 'MEDIUM', dueTime: '17:30' },
          test: expectStatus(200),
        }),
        req('Task detail (admin)', 'GET', '/tasks/{{adminTaskId}}', {
          auth: 'admin',
          test: expectStatus(200),
        }),
        req('Delete task', 'DELETE', '/admin/tasks/{{adminTaskId}}', {
          auth: 'admin',
          test: expectStatus(200),
        }),
        req('Create announcement', 'POST', '/admin/announcements', {
          auth: 'admin',
          body: {
            title: 'Hangar 2 closed for maintenance',
            body: 'Hangar 2 is closed on Friday. Use Hangar 1 for all inspections.',
            category: 'GENERAL',
            isPinned: false,
            notify: false,
          },
          test:
            expectStatus(201) +
            `
pm.collectionVariables.set('adminAnnouncementId', pm.response.json().data.id);
`,
        }),
        req('Update announcement', 'PATCH', '/admin/announcements/{{adminAnnouncementId}}', {
          auth: 'admin',
          body: { isPinned: true },
          test: expectStatus(200),
        }),
        req('Delete announcement (soft)', 'DELETE', '/admin/announcements/{{adminAnnouncementId}}', {
          auth: 'admin',
          test: expectStatus(200),
        }),
        req('Manual attendance', 'POST', '/admin/attendance/manual', {
          auth: 'admin',
          body:
            '{\n  "userId": {{assigneeId}},\n  "workDate": "2026-01-05",\n  "clockInUtc": "2026-01-05T01:02:00Z",\n' +
            '  "clockOutUtc": "2026-01-05T10:00:00Z",\n  "reason": "Phone battery died; confirmed by supervisor"\n}',
          description: '409 ALREADY_CLOCKED_IN when re-run (a record for that user and date exists).',
          test: expectStatus([201, 409]),
        }),
        req('Daily reports', 'GET', '/admin/reports?date={{today}}', {
          auth: 'admin',
          test: expectStatus(200),
        }),
        req('Record leave', 'POST', '/admin/leaves', {
          auth: 'admin',
          body: '{\n  "userId": {{leaveUserId}},\n  "fromDate": "2026-12-21",\n  "toDate": "2026-12-24",\n  "reason": "Year-end leave"\n}',
          description: '400 VALIDATION_ERROR when re-run (overlapping leave).',
          test: expectStatus([201, 400]),
        }),
        req('Leaves on a date', 'GET', '/admin/leaves?date=2026-12-22', {
          auth: 'admin',
          test: expectStatus(200),
        }),
      ],
    },
    {
      name: '5. Sign out',
      item: [
        req('Logout', 'POST', '/auth/logout', {
          body: '{\n  "refreshToken": "{{refreshToken}}"\n}',
          test: expectStatus(200),
        }),
        req('Refresh after logout → 401', 'POST', '/auth/refresh', {
          auth: 'none',
          body: '{\n  "refreshToken": "{{refreshToken}}"\n}',
          test: expectStatus(401),
        }),
      ],
    },
  ],
};

fs.writeFileSync('docs/postman/LEADS-Attendance.postman_collection.json', json(collection) + '\n');
console.log('Wrote docs/postman/LEADS-Attendance.postman_collection.json');
