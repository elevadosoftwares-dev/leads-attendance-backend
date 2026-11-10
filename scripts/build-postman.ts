/* eslint-disable no-console */
/**
 * Builds the Postman documentation collection, docs/postman/LEADS-Attendance.postman_collection.json.
 *
 *   npm run docs:postman
 *
 * Every request is actually executed against a throw-away copy of the test database (leads_attendance_test,
 * recreated here), and the real responses are saved as Postman examples. Descriptions, field tables and the
 * list of possible responses come from openapi.yaml. The build fails if any operation in the spec is missing.
 * Tokens in the saved examples are replaced with placeholders.
 */
// Must load first: points the app at the test database before env.ts is evaluated.
import '../tests/setup-env';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import YAML from 'yaml';
import { closePool } from '../src/db/pool';
import { recreateTestDatabase, runMigrations } from '../src/db/migrator';
import { addDaysToWorkDate, combineWorkDateAndTime, todayWorkDate } from '../src/utils/time';
import {
  OFFICE,
  PASSWORD,
  app,
  createAttendance,
  createOffice,
  createTask,
  createUser,
} from '../tests/helpers';

type Method = 'get' | 'post' | 'patch' | 'delete';
type Who = 'public' | 'employee' | 'admin' | 'superAdmin' | 'anyone';

interface Call {
  op: string;
  folder: string;
  name: string;
  method: Method;
  /** Path as shown in Postman, e.g. /tasks/:id. */
  path: string;
  params?: Record<string, string | number>;
  query?: Record<string, string | number>;
  auth: Who;
  body?: unknown;
  /** Shown instead of `body` in the Postman request (e.g. to use {{password}} variables). */
  shownBody?: string;
  file?: string;
  /** Saved as an extra example on the request named here instead of becoming its own request. */
  exampleFor?: string;
  /** Postman test script, used on login requests to store tokens. */
  test?: string;
  expect: number;
}

interface Captured extends Call {
  status: number;
  responseBody: string;
  contentType: string;
}

const FOLDERS: Array<[string, string]> = [
  ['Health', 'Liveness and database connectivity.'],
  ['Auth', 'Sign up, sign in, token refresh and password reset. These requests need no token.'],
  ['Me', 'The signed-in user: profile, push token, password, and the employee home screen.'],
  ['Attendance (employee)', 'Clock in and out from inside the office geofence, and attendance history.'],
  ['Leave (employee)', 'Request leave, see its status, and withdraw a request.'],
  ['Tasks (employee)', "The employee's own tasks, status changes and attachments."],
  ['Announcements', 'Company announcements, visible to every signed-in user.'],
  ['Admin: dashboard', 'Live dashboard data. ADMIN or SUPER_ADMIN.'],
  ['Admin: tasks', 'Create, list, update and delete tasks for employees. ADMIN or SUPER_ADMIN.'],
  ['Admin: announcements', 'Publish and manage announcements. ADMIN or SUPER_ADMIN.'],
  ['Admin: attendance, reports and leaves', 'Corrections, daily reports and leave. ADMIN or SUPER_ADMIN.'],
  [
    'Admin: users',
    'Accounts. Admins manage EMPLOYEE accounts; only the SUPER_ADMIN manages admins and sets shift times.',
  ],
  [
    'Super admin: office settings',
    'Office name, address, location, geofence radius, default shift start and end, late grace minutes and timezone. ' +
      'Any admin can read them; only the SUPER_ADMIN can change them.',
  ],
  ['Sign out', 'End the session.'],
];

const TOKEN_VAR: Record<Exclude<Who, 'public' | 'anyone'>, string> = {
  employee: '{{employeeToken}}',
  admin: '{{adminToken}}',
  superAdmin: '{{superAdminToken}}',
};
const WHO_TEXT: Record<Who, string> = {
  public: 'Public (no token)',
  anyone: 'Any signed-in user',
  employee: 'EMPLOYEE',
  admin: 'ADMIN or SUPER_ADMIN',
  superAdmin: 'SUPER_ADMIN only',
};

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

// ---------------------------------------------------------------------------------------------- OpenAPI

type Schema = Record<string, unknown>;
const spec = YAML.parse(fs.readFileSync(path.resolve('openapi.yaml'), 'utf8')) as {
  info: { title: string; description: string };
  paths: Record<string, Record<string, Schema>>;
  components: Record<string, Record<string, Schema>>;
};

function deref<T = Schema>(node: unknown): T {
  let n = node as Schema;
  while (n && typeof n.$ref === 'string') {
    const [, , section, name] = (n.$ref as string).split('/');
    n = spec.components[section!]![name!]!;
  }
  return n as T;
}

const operations = new Map<string, { method: string; route: string; op: Schema }>();
for (const [route, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops))
    operations.set(op.operationId as string, { method, route, op });
}

/** Flattens allOf / $ref into one object schema. */
function objectSchema(schema: unknown): { properties: Record<string, Schema>; required: string[] } {
  const s = deref(schema);
  const out = { properties: {} as Record<string, Schema>, required: [] as string[] };
  for (const part of (s.allOf as unknown[]) ?? []) {
    const p = objectSchema(part);
    Object.assign(out.properties, p.properties);
    out.required.push(...p.required);
  }
  Object.assign(out.properties, (s.properties as Record<string, Schema>) ?? {});
  out.required.push(...((s.required as string[]) ?? []));
  return out;
}

function typeOf(schema: unknown): string {
  const s = deref(schema);
  if (s.allOf) return typeOf((s.allOf as unknown[])[0]);
  if (s.enum) return (s.enum as unknown[]).join(' \\| ');
  if (s.const !== undefined) return String(s.const);
  const t = Array.isArray(s.type) ? (s.type as string[]).join(' \\| ') : ((s.type as string) ?? 'object');
  if (t === 'array') return `${typeOf(s.items)}[]`;
  return s.format ? `${t} (${s.format as string})` : t;
}

function notesOf(schema: unknown): string {
  const s = deref(schema);
  const raw = schema as Schema;
  const parts: string[] = [];
  const add = (label: string, v: unknown) => v !== undefined && parts.push(`${label} ${String(v)}`);
  add('min', s.minimum);
  add('max', s.maximum);
  add('min length', s.minLength);
  add('max length', s.maxLength);
  if (s.pattern) parts.push(`pattern \`${s.pattern as string}\``);
  add('default', raw.default ?? s.default);
  const desc = (raw.description ?? s.description) as string | undefined;
  if (desc) parts.push(desc.replace(/\s+/g, ' ').trim());
  return parts.join('; ').replace(/\|/g, '\\|');
}

function fieldTable(title: string, rows: Array<[string, string, boolean, string]>): string {
  if (rows.length === 0) return '';
  return [
    `**${title}**`,
    '',
    '| Field | Type | Required | Notes |',
    '|---|---|---|---|',
    ...rows.map(([n, t, r, x]) => `| \`${n}\` | ${t} | ${r ? 'yes' : 'no'} | ${x} |`),
    '',
  ].join('\n');
}

function describe(call: Call): string {
  const entry = operations.get(call.op)!;
  const op = entry.op;
  const lines: string[] = [];
  lines.push(`**${op.summary as string}**`, '');
  lines.push(
    `\`${entry.method.toUpperCase()} /api/v1${entry.route}\` · **Who can call:** ${WHO_TEXT[call.auth]}`,
    '',
  );
  if (op.description) lines.push((op.description as string).trim(), '');

  const params = ((op.parameters as unknown[]) ?? []).map((p) => deref(p));
  const pathParams = params.filter((p) => p.in === 'path');
  const queryParams = params.filter((p) => p.in === 'query');
  lines.push(
    fieldTable(
      'Path parameters',
      pathParams.map((p) => [
        p.name as string,
        typeOf(p.schema),
        true,
        notesOf({ ...(p.schema as Schema), description: p.description }),
      ]),
    ),
  );
  lines.push(
    fieldTable(
      'Query parameters',
      queryParams.map((p) => [
        p.name as string,
        typeOf(p.schema),
        Boolean(p.required),
        notesOf({ ...(p.schema as Schema), description: p.description }),
      ]),
    ),
  );

  const content = (op.requestBody as Schema | undefined)?.content as
    Record<string, { schema: unknown }> | undefined;
  if (content) {
    const [contentType, media] = Object.entries(content)[0]!;
    const body = objectSchema(media.schema);
    lines.push(
      fieldTable(
        `Body (${contentType})`,
        Object.entries(body.properties).map(([name, s]) => [
          name,
          typeOf(s),
          body.required.includes(name),
          notesOf(s),
        ]),
      ),
    );
  }

  const responses = Object.entries((op.responses as Record<string, unknown>) ?? {});
  lines.push('**Responses**', '');
  for (const [code, r] of responses) {
    const desc = (deref(r).description as string).replace(/\s+/g, ' ').trim();
    lines.push(`- \`${code}\` ${desc}`);
  }
  lines.push('', 'See the saved examples for real request and response bodies.');
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// ---------------------------------------------------------------------------------------------- Running

const tokens: Partial<Record<'employee' | 'admin' | 'superAdmin', string>> = {};

function resolvePath(call: Call): string {
  let p = call.path;
  for (const [k, v] of Object.entries(call.params ?? {})) p = p.replace(`:${k}`, String(v));
  const q = new URLSearchParams(
    Object.entries(call.query ?? {}).map(([k, v]): [string, string] => [k, String(v)]),
  ).toString();
  return `/api/v1${p}${q ? `?${q}` : ''}`;
}

const redact = (text: string) =>
  text
    .replace(
      /"accessToken":\s*"[^"]+"/g,
      '"accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<signature>"',
    )
    .replace(/"refreshToken":\s*"(?!\{\{)[^"]+"/g, '"refreshToken": "<64-byte opaque refresh token>"');

async function run(call: Call): Promise<Captured> {
  let req = request(app)[call.method](resolvePath(call));
  if (call.auth !== 'public') {
    const role = call.auth === 'anyone' ? 'employee' : call.auth;
    req = req.set('Authorization', `Bearer ${tokens[role]}`);
  }
  if (call.file) req = req.attach('file', call.file);
  else if (call.body !== undefined) req = req.send(call.body as object);
  const res = await req;
  if (res.status !== call.expect) {
    throw new Error(`${call.name}: expected ${call.expect}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  const contentType = String(res.headers['content-type'] ?? '');
  const responseBody = contentType.includes('json')
    ? redact(JSON.stringify(res.body, null, 2))
    : `<binary ${contentType.split(';')[0]}, ${res.headers['content-length'] ?? '?'} bytes>`;
  return { ...call, status: res.status, responseBody, contentType };
}

// ---------------------------------------------------------------------------------------------- Postman

function postmanRequest(call: Call, description?: string) {
  const query = Object.entries(call.query ?? {}).map(([key, value]) => ({ key, value: String(value) }));
  const variable = Object.entries(call.params ?? {}).map(([key, value]) => ({ key, value: String(value) }));
  const raw = `{{baseUrl}}${call.path}${query.length ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : ''}`;
  const req: Record<string, unknown> = {
    method: call.method.toUpperCase(),
    header: [] as Array<{ key: string; value: string }>,
    url: {
      raw,
      host: ['{{baseUrl}}'],
      path: call.path.split('/').filter(Boolean),
      ...(query.length ? { query } : {}),
      ...(variable.length ? { variable } : {}),
    },
    auth:
      call.auth === 'public'
        ? { type: 'noauth' }
        : {
            type: 'bearer',
            bearer: [
              {
                key: 'token',
                value: TOKEN_VAR[call.auth === 'anyone' ? 'employee' : call.auth],
                type: 'string',
              },
            ],
          },
  };
  if (description) req.description = description;
  if (call.file) {
    req.body = { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: path.basename(call.file) }] };
  } else if (call.body !== undefined || call.shownBody) {
    (req.header as Array<{ key: string; value: string }>).push({
      key: 'Content-Type',
      value: 'application/json',
    });
    req.body = {
      mode: 'raw',
      raw: call.shownBody ?? JSON.stringify(call.body, null, 2),
      options: { raw: { language: 'json' } },
    };
  }
  return req;
}

function example(c: Captured, label: string) {
  const json = c.contentType.includes('json');
  return {
    name: label,
    originalRequest: postmanRequest(c),
    status: STATUS_TEXT[c.status] ?? String(c.status),
    code: c.status,
    _postman_previewlanguage: json ? 'json' : 'text',
    header: [{ key: 'Content-Type', value: c.contentType || 'application/json' }],
    cookie: [],
    body: c.responseBody,
  };
}

// ---------------------------------------------------------------------------------------------- Scenario

async function main() {
  const testDb = process.env.DB_NAME!;
  await recreateTestDatabase(testDb);
  await runMigrations(testDb);

  const today = todayWorkDate();
  const yesterday = addDaysToWorkDate(today, -1);
  const officeId = await createOffice();
  const superAdmin = await createUser(officeId, {
    role: 'SUPER_ADMIN',
    name: 'Super Admin',
    email: 'superadmin@leads-ndt.com',
  });
  const admin = await createUser(officeId, {
    role: 'ADMIN',
    name: 'Grace Ong',
    email: 'grace.ong@leads-ndt.com',
  });
  const mark = await createUser(officeId, { name: 'Mark Tan', email: 'mark.tan@leads-ndt.com' });
  const john = await createUser(officeId, { name: 'John Lim', email: 'john.lim@leads-ndt.com' });
  const sarah = await createUser(officeId, { name: 'Sarah Lee', email: 'sarah.lee@leads-ndt.com' });
  await createAttendance({
    userId: sarah.id,
    workDate: today,
    clockInUtc: new Date(Date.now() - 2 * 3600_000),
    isLate: true,
  });
  const markTask = await createTask({
    assigneeId: mark.id,
    createdBy: admin.id,
    dueDate: today,
    title: 'Ultrasonic inspection, wing spar WO-24117',
    priority: 'HIGH',
  });
  const carryTask = await createTask({
    assigneeId: mark.id,
    createdBy: admin.id,
    dueDate: today,
    dueTime: '16:00',
    title: 'Eddy current check, landing gear NTM-212',
  });

  const fix = { latitude: OFFICE.lat, longitude: OFFICE.lng, accuracy: 8, isMocked: false };
  const credentials = (emailVar: string, passwordVar: string) =>
    `{\n  "email": "{{${emailVar}}}",\n  "password": "{{${passwordVar}}}"\n}`;
  const saveToken = (variable: string) =>
    [
      'const data = pm.response.json().data;',
      `if (data && data.accessToken) {`,
      `  pm.collectionVariables.set('${variable}', data.accessToken);`,
      `  pm.collectionVariables.set('refreshToken', data.refreshToken);`,
      '}',
    ].join('\n');

  const captured: Captured[] = [];
  const exec = async (call: Call) => {
    const c = await run(call);
    captured.push(c);
    return JSON.parse(c.contentType.includes('json') ? c.responseBody.replace(/<[^>]+>/g, 'x') : '{}');
  };
  const loginAs = async (who: 'superAdmin' | 'admin' | 'employee', email: string, name: string) => {
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    tokens[who] = res.body.data.accessToken;
    const vars = { superAdmin: 'superAdmin', admin: 'admin', employee: 'employee' }[who];
    captured.push({
      op: 'login',
      folder: 'Auth',
      name,
      method: 'post',
      path: '/auth/login',
      auth: 'public',
      body: { email, password: PASSWORD },
      shownBody: credentials(`${vars}Email`, `${vars}Password`),
      test: saveToken(`${vars}Token`),
      expect: 200,
      status: res.status,
      responseBody: redact(JSON.stringify(res.body, null, 2)),
      contentType: String(res.headers['content-type']),
    });
    return res.body.data.refreshToken as string;
  };

  // Health and auth
  await exec({
    op: 'getHealth',
    folder: 'Health',
    name: 'Health check',
    method: 'get',
    path: '/health',
    auth: 'public',
    expect: 200,
  });
  await loginAs('superAdmin', superAdmin.email, 'Login (super admin)');
  await loginAs('admin', admin.email, 'Login (admin)');
  const markRefresh = await loginAs('employee', mark.email, 'Login (employee)');
  await exec({
    op: 'login',
    folder: 'Auth',
    name: 'Wrong password',
    exampleFor: 'Login (employee)',
    method: 'post',
    path: '/auth/login',
    auth: 'public',
    body: { email: mark.email, password: 'Wrong-pass-1' },
    expect: 401,
  });
  const signup = await exec({
    op: 'signup',
    folder: 'Auth',
    name: 'Sign up (employee)',
    method: 'post',
    path: '/auth/signup',
    auth: 'public',
    body: { name: 'Jane Lim', email: 'jane.lim@leads-ndt.com', password: 'Welcome123' },
    expect: 201,
  });
  await exec({
    op: 'signup',
    folder: 'Auth',
    name: 'Email already registered',
    exampleFor: 'Sign up (employee)',
    method: 'post',
    path: '/auth/signup',
    auth: 'public',
    body: { name: 'Mark Tan', email: mark.email, password: 'Welcome123' },
    expect: 409,
  });
  await exec({
    op: 'signup',
    folder: 'Auth',
    name: 'Validation error',
    exampleFor: 'Sign up (employee)',
    method: 'post',
    path: '/auth/signup',
    auth: 'public',
    body: { name: 'J', email: 'not-an-email', password: 'short' },
    expect: 400,
  });
  await exec({
    op: 'login',
    folder: 'Auth',
    name: 'Account waiting for approval',
    exampleFor: 'Login (employee)',
    method: 'post',
    path: '/auth/login',
    auth: 'public',
    body: { email: 'jane.lim@leads-ndt.com', password: 'Welcome123' },
    expect: 403,
  });
  const refreshed = await exec({
    op: 'refreshTokens',
    folder: 'Auth',
    name: 'Refresh tokens',
    method: 'post',
    path: '/auth/refresh',
    auth: 'public',
    body: { refreshToken: markRefresh },
    shownBody: '{\n  "refreshToken": "{{refreshToken}}"\n}',
    expect: 200,
    test: saveToken('employeeToken'),
  });
  void refreshed;
  await exec({
    op: 'forgotPassword',
    folder: 'Auth',
    name: 'Forgot password',
    method: 'post',
    path: '/auth/forgot-password',
    auth: 'public',
    body: { email: john.email },
    expect: 200,
  });
  await exec({
    op: 'resetPassword',
    folder: 'Auth',
    name: 'Reset password (invalid token)',
    method: 'post',
    path: '/auth/reset-password',
    auth: 'public',
    body: { token: 'token-from-the-reset-link', newPassword: 'NewPassw0rd' },
    expect: 400,
  });

  // Me
  await exec({
    op: 'getMe',
    folder: 'Me',
    name: 'My profile',
    method: 'get',
    path: '/me',
    auth: 'anyone',
    expect: 200,
  });
  await exec({
    op: 'registerDeviceToken',
    folder: 'Me',
    name: 'Register push token',
    method: 'post',
    path: '/me/device-token',
    auth: 'anyone',
    body: { fcmToken: 'cWaobrarS0WCy5DLKo-syw:APA91bExampleToken', platform: 'android' },
    expect: 200,
  });
  await exec({
    op: 'getMe',
    folder: 'Me',
    name: 'Missing or invalid token',
    exampleFor: 'My profile',
    method: 'get',
    path: '/me',
    auth: 'public',
    expect: 401,
  });
  await exec({
    op: 'getToday',
    folder: 'Me',
    name: 'Home screen (today)',
    method: 'get',
    path: '/me/today',
    auth: 'employee',
    expect: 200,
  });

  // Attendance and tasks (employee)
  await exec({
    op: 'clockIn',
    folder: 'Attendance (employee)',
    name: 'Outside the geofence',
    exampleFor: 'Clock in',
    method: 'post',
    path: '/attendance/clock-in',
    auth: 'employee',
    body: { ...fix, latitude: OFFICE.lat + 0.01 },
    expect: 422,
  });
  await exec({
    op: 'clockIn',
    folder: 'Attendance (employee)',
    name: 'Clock in',
    method: 'post',
    path: '/attendance/clock-in',
    auth: 'employee',
    body: fix,
    expect: 201,
  });
  await exec({
    op: 'clockIn',
    folder: 'Attendance (employee)',
    name: 'Already clocked in',
    exampleFor: 'Clock in',
    method: 'post',
    path: '/attendance/clock-in',
    auth: 'employee',
    body: fix,
    expect: 409,
  });
  await exec({
    op: 'getCurrentShift',
    folder: 'Attendance (employee)',
    name: 'Current shift',
    method: 'get',
    path: '/attendance/current',
    auth: 'employee',
    expect: 200,
  });
  await exec({
    op: 'listMyTasks',
    folder: 'Tasks (employee)',
    name: 'My tasks for a date',
    method: 'get',
    path: '/tasks',
    query: { date: today },
    auth: 'employee',
    expect: 200,
  });
  await exec({
    op: 'getTask',
    folder: 'Tasks (employee)',
    name: 'Task detail',
    method: 'get',
    path: '/tasks/:id',
    params: { id: markTask },
    auth: 'employee',
    expect: 200,
  });
  await exec({
    op: 'updateTaskStatus',
    folder: 'Tasks (employee)',
    name: 'Start task',
    method: 'patch',
    path: '/tasks/:id/status',
    params: { id: markTask },
    auth: 'employee',
    body: { status: 'IN_PROGRESS' },
    expect: 200,
  });
  await exec({
    op: 'updateTaskStatus',
    folder: 'Tasks (employee)',
    name: 'Not allowed status change',
    exampleFor: 'Start task',
    method: 'patch',
    path: '/tasks/:id/status',
    params: { id: markTask },
    auth: 'employee',
    body: { status: 'TODO' },
    expect: 400,
  });
  const attachment = await exec({
    op: 'uploadTaskAttachment',
    folder: 'Tasks (employee)',
    name: 'Upload attachment',
    method: 'post',
    path: '/tasks/:id/attachments',
    params: { id: markTask },
    auth: 'employee',
    file: path.resolve('docs/postman/sample-report.pdf'),
    expect: 201,
  });
  await exec({
    op: 'downloadFile',
    folder: 'Tasks (employee)',
    name: 'Download attachment',
    method: 'get',
    path: '/files/:id',
    params: { id: attachment.data.id },
    auth: 'employee',
    expect: 200,
  });
  await exec({
    op: 'clockOut',
    folder: 'Attendance (employee)',
    name: 'Clock out with daily report',
    method: 'post',
    path: '/attendance/clock-out',
    auth: 'employee',
    body: {
      ...fix,
      summary: 'Completed ultrasonic inspection of the wing spar. Report uploaded.',
      blockers: 'Waiting for the eddy current probe to be recalibrated.',
      notes: null,
      carryOverTaskIds: [carryTask],
    },
    expect: 200,
  });
  await exec({
    op: 'clockOut',
    folder: 'Attendance (employee)',
    name: 'Not clocked in',
    exampleFor: 'Clock out with daily report',
    method: 'post',
    path: '/attendance/clock-out',
    auth: 'employee',
    body: { ...fix, summary: 'Done' },
    expect: 404,
  });
  await exec({
    op: 'getAttendanceHistory',
    folder: 'Attendance (employee)',
    name: 'Attendance history (month)',
    method: 'get',
    path: '/attendance/history',
    query: { month: today.slice(0, 7) },
    auth: 'employee',
    expect: 200,
  });

  // Admin: tasks
  const created = await exec({
    op: 'adminCreateTask',
    folder: 'Admin: tasks',
    name: 'Create task',
    method: 'post',
    path: '/admin/tasks',
    auth: 'admin',
    body: {
      title: 'Magnetic particle inspection, engine mount',
      description: 'Use the portable yoke. Record indications on form NDT-07.',
      assigneeId: john.id,
      priority: 'MEDIUM',
      dueDate: today,
      dueTime: '17:00',
      notify: true,
    },
    expect: 201,
  });
  await exec({
    op: 'adminListTasks',
    folder: 'Admin: tasks',
    name: 'List tasks',
    method: 'get',
    path: '/admin/tasks',
    query: { date: today, page: 1, pageSize: 20 },
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'adminTaskStats',
    folder: 'Admin: tasks',
    name: 'Task stats',
    method: 'get',
    path: '/admin/tasks/stats',
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'adminUpdateTask',
    folder: 'Admin: tasks',
    name: 'Update task',
    method: 'patch',
    path: '/admin/tasks/:id',
    params: { id: created.data.id },
    auth: 'admin',
    body: { priority: 'HIGH', dueTime: '15:30' },
    expect: 200,
  });
  await exec({
    op: 'adminDeleteTask',
    folder: 'Admin: tasks',
    name: 'Delete task',
    method: 'delete',
    path: '/admin/tasks/:id',
    params: { id: created.data.id },
    auth: 'admin',
    expect: 200,
  });

  // Announcements
  const announcement = await exec({
    op: 'adminCreateAnnouncement',
    folder: 'Admin: announcements',
    name: 'Create announcement',
    method: 'post',
    path: '/admin/announcements',
    auth: 'admin',
    body: {
      title: 'Hangar 2 closed on Friday',
      body: 'Hangar 2 is closed on Friday for floor resurfacing. Use Hangar 1 for all inspections.',
      category: 'SAFETY',
      isPinned: true,
      notify: true,
    },
    expect: 201,
  });
  await exec({
    op: 'listAnnouncements',
    folder: 'Announcements',
    name: 'List announcements',
    method: 'get',
    path: '/announcements',
    query: { page: 1, pageSize: 20 },
    auth: 'anyone',
    expect: 200,
  });
  await exec({
    op: 'getAnnouncement',
    folder: 'Announcements',
    name: 'Announcement detail',
    method: 'get',
    path: '/announcements/:id',
    params: { id: announcement.data.id },
    auth: 'anyone',
    expect: 200,
  });
  await exec({
    op: 'adminUpdateAnnouncement',
    folder: 'Admin: announcements',
    name: 'Update announcement',
    method: 'patch',
    path: '/admin/announcements/:id',
    params: { id: announcement.data.id },
    auth: 'admin',
    body: { isPinned: false },
    expect: 200,
  });
  await exec({
    op: 'adminDeleteAnnouncement',
    folder: 'Admin: announcements',
    name: 'Delete announcement',
    method: 'delete',
    path: '/admin/announcements/:id',
    params: { id: announcement.data.id },
    auth: 'admin',
    expect: 200,
  });

  // Admin: dashboard, attendance, reports, leaves
  await exec({
    op: 'adminGetOverview',
    folder: 'Admin: dashboard',
    name: 'Overview',
    method: 'get',
    path: '/admin/overview',
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'adminGetLiveAttendance',
    folder: 'Admin: dashboard',
    name: 'Live attendance',
    method: 'get',
    path: '/admin/attendance/live',
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'adminGetOverview',
    folder: 'Admin: dashboard',
    name: 'Employee token',
    exampleFor: 'Overview',
    method: 'get',
    path: '/admin/overview',
    auth: 'employee',
    expect: 403,
  });
  await exec({
    op: 'adminAddManualAttendance',
    folder: 'Admin: attendance, reports and leaves',
    name: 'Add manual attendance',
    method: 'post',
    path: '/admin/attendance/manual',
    auth: 'admin',
    body: {
      userId: john.id,
      workDate: yesterday,
      clockInUtc: combineWorkDateAndTime(yesterday, '09:04').toISOString().replace('.000', ''),
      clockOutUtc: combineWorkDateAndTime(yesterday, '18:02').toISOString().replace('.000', ''),
      reason: 'Phone battery died before clock-in',
    },
    expect: 201,
  });
  await exec({
    op: 'adminListReports',
    folder: 'Admin: attendance, reports and leaves',
    name: 'Daily reports',
    method: 'get',
    path: '/admin/reports',
    query: { date: today },
    auth: 'admin',
    expect: 200,
  });
  const leaveFrom = addDaysToWorkDate(today, 14);
  await exec({
    op: 'adminCreateLeave',
    folder: 'Admin: attendance, reports and leaves',
    name: 'Record leave',
    method: 'post',
    path: '/admin/leaves',
    auth: 'admin',
    body: {
      userId: john.id,
      fromDate: leaveFrom,
      toDate: addDaysToWorkDate(leaveFrom, 3),
      reason: 'Annual leave',
    },
    expect: 201,
  });
  await exec({
    op: 'adminListLeaves',
    folder: 'Admin: attendance, reports and leaves',
    name: 'Leaves on a date',
    method: 'get',
    path: '/admin/leaves',
    query: { date: leaveFrom },
    auth: 'admin',
    expect: 200,
  });
  const requestFrom = addDaysToWorkDate(today, 21);
  const requested = await exec({
    op: 'requestLeave',
    folder: 'Leave (employee)',
    name: 'Request leave',
    method: 'post',
    path: '/me/leaves',
    auth: 'employee',
    body: { fromDate: requestFrom, toDate: addDaysToWorkDate(requestFrom, 1), reason: 'Family function' },
    expect: 201,
  });
  const second = await exec({
    op: 'requestLeave',
    folder: 'Leave (employee)',
    name: 'Request another day',
    method: 'post',
    path: '/me/leaves',
    auth: 'employee',
    body: {
      fromDate: addDaysToWorkDate(requestFrom, 7),
      toDate: addDaysToWorkDate(requestFrom, 7),
      reason: 'Doctor',
    },
    expect: 201,
  });
  const third = await exec({
    op: 'requestLeave',
    folder: 'Leave (employee)',
    name: 'Request a third day',
    method: 'post',
    path: '/me/leaves',
    auth: 'employee',
    body: {
      fromDate: addDaysToWorkDate(requestFrom, 9),
      toDate: addDaysToWorkDate(requestFrom, 9),
      reason: 'Errands',
    },
    expect: 201,
  });
  await exec({
    op: 'listMyLeaves',
    folder: 'Leave (employee)',
    name: 'My leave',
    method: 'get',
    path: '/me/leaves',
    auth: 'employee',
    expect: 200,
  });
  await exec({
    op: 'withdrawLeave',
    folder: 'Leave (employee)',
    name: 'Withdraw a request',
    method: 'post',
    path: '/me/leaves/:id/withdraw',
    params: { id: third.data.id },
    auth: 'employee',
    expect: 200,
  });
  await exec({
    op: 'adminListLeaves',
    folder: 'Admin: attendance, reports and leaves',
    name: 'Pending leave requests',
    method: 'get',
    path: '/admin/leaves',
    query: { status: 'PENDING' },
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'adminApproveLeave',
    folder: 'Admin: attendance, reports and leaves',
    name: 'Approve leave request',
    method: 'post',
    path: '/admin/leaves/:id/approve',
    params: { id: requested.data.id },
    auth: 'admin',
    body: { note: 'Approved' },
    expect: 200,
  });
  await exec({
    op: 'adminRejectLeave',
    folder: 'Admin: attendance, reports and leaves',
    name: 'Reject leave request',
    method: 'post',
    path: '/admin/leaves/:id/reject',
    params: { id: second.data.id },
    auth: 'admin',
    body: { note: 'Audit that week' },
    expect: 200,
  });
  await exec({
    op: 'adminCancelLeave',
    folder: 'Admin: attendance, reports and leaves',
    name: 'Cancel approved leave',
    method: 'post',
    path: '/admin/leaves/:id/cancel',
    params: { id: requested.data.id },
    auth: 'admin',
    body: { note: 'Plans changed' },
    expect: 200,
  });

  // Admin: users
  const janeId = signup.data.id as number;
  await exec({
    op: 'adminListUsers',
    folder: 'Admin: users',
    name: 'Pending sign-ups',
    method: 'get',
    path: '/admin/users',
    query: { status: 'PENDING' },
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'adminApproveUser',
    folder: 'Admin: users',
    name: 'Approve sign-up',
    method: 'post',
    path: '/admin/users/:id/approve',
    params: { id: janeId },
    auth: 'admin',
    body: {},
    expect: 200,
  });
  const reject = await request(app)
    .post('/api/v1/auth/signup')
    .send({ name: 'Unknown Person', email: 'unknown.person@gmail.com', password: 'Welcome123' });
  await exec({
    op: 'adminRejectUser',
    folder: 'Admin: users',
    name: 'Reject sign-up',
    method: 'post',
    path: '/admin/users/:id/reject',
    params: { id: reject.body.data.id },
    auth: 'admin',
    expect: 200,
  });
  const employee = await exec({
    op: 'adminCreateUser',
    folder: 'Admin: users',
    name: 'Create employee',
    method: 'post',
    path: '/admin/users',
    auth: 'admin',
    body: { name: 'David Ng', email: 'david.ng@leads-ndt.com', password: 'Welcome123', role: 'EMPLOYEE' },
    expect: 201,
  });
  await exec({
    op: 'adminCreateUser',
    folder: 'Admin: users',
    name: 'Admin tries to create an admin',
    exampleFor: 'Create employee',
    method: 'post',
    path: '/admin/users',
    auth: 'admin',
    body: { name: 'Kevin Chua', email: 'kevin.chua@leads-ndt.com', password: 'Welcome123', role: 'ADMIN' },
    expect: 403,
  });
  await exec({
    op: 'adminCreateUser',
    folder: 'Admin: users',
    name: 'Create admin (super admin)',
    method: 'post',
    path: '/admin/users',
    auth: 'superAdmin',
    body: {
      name: 'Kevin Chua',
      email: 'kevin.chua@leads-ndt.com',
      password: 'Welcome123',
      role: 'ADMIN',
      shiftStart: '08:30',
      shiftEnd: '17:30',
    },
    expect: 201,
  });
  await exec({
    op: 'adminUpdateUser',
    folder: 'Admin: users',
    name: 'Rename user',
    method: 'patch',
    path: '/admin/users/:id',
    params: { id: employee.data.id },
    auth: 'admin',
    body: { name: 'David Ng Wei' },
    expect: 200,
  });
  await exec({
    op: 'adminUpdateUser',
    folder: 'Admin: users',
    name: 'Admin tries to set a shift time',
    exampleFor: 'Rename user',
    method: 'patch',
    path: '/admin/users/:id',
    params: { id: employee.data.id },
    auth: 'admin',
    body: { shiftStart: '10:00' },
    expect: 403,
  });
  await exec({
    op: 'adminUpdateUser',
    folder: 'Admin: users',
    name: 'Change shift / promote (super admin)',
    method: 'patch',
    path: '/admin/users/:id',
    params: { id: employee.data.id },
    auth: 'superAdmin',
    body: { shiftStart: '10:00', shiftEnd: '19:00', role: 'ADMIN' },
    expect: 200,
  });
  await exec({
    op: 'adminDeactivateUser',
    folder: 'Admin: users',
    name: 'Remove user',
    method: 'delete',
    path: '/admin/users/:id',
    params: { id: sarah.id },
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'adminDeactivateUser',
    folder: 'Admin: users',
    name: 'Admin tries to remove the super admin',
    exampleFor: 'Remove user',
    method: 'delete',
    path: '/admin/users/:id',
    params: { id: superAdmin.id },
    auth: 'admin',
    expect: 403,
  });
  await exec({
    op: 'adminListUsers',
    folder: 'Admin: users',
    name: 'Active users',
    method: 'get',
    path: '/admin/users',
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'adminListUsers',
    folder: 'Admin: users',
    name: 'Removed users',
    method: 'get',
    path: '/admin/users',
    query: { status: 'INACTIVE' },
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'adminReactivateUser',
    folder: 'Admin: users',
    name: 'Reactivate user',
    method: 'post',
    path: '/admin/users/:id/reactivate',
    params: { id: sarah.id },
    auth: 'admin',
    expect: 200,
  });

  // Super admin: office
  await exec({
    op: 'adminGetOffice',
    folder: 'Super admin: office settings',
    name: 'Office settings',
    method: 'get',
    path: '/admin/office',
    auth: 'admin',
    expect: 200,
  });
  await exec({
    op: 'superAdminUpdateOffice',
    folder: 'Super admin: office settings',
    name: 'Update office settings',
    method: 'patch',
    path: '/admin/office',
    auth: 'superAdmin',
    body: {
      name: 'LEADS Office Geofence',
      address: '123 Aerospace Tech Park, Singapore',
      latitude: 1.417,
      longitude: 103.868,
      radiusMeters: 200,
      defaultShiftStart: '08:30',
      defaultShiftEnd: '17:30',
      lateGraceMinutes: 15,
      applyShiftToAllUsers: false,
    },
    expect: 200,
  });
  await exec({
    op: 'superAdminUpdateOffice',
    folder: 'Super admin: office settings',
    name: 'Admin token (not allowed)',
    exampleFor: 'Update office settings',
    method: 'patch',
    path: '/admin/office',
    auth: 'admin',
    body: { radiusMeters: 500 },
    expect: 403,
  });

  // Me: change password, then sign out
  await exec({
    op: 'changePassword',
    folder: 'Me',
    name: 'Change password',
    method: 'post',
    path: '/me/change-password',
    auth: 'anyone',
    body: { currentPassword: PASSWORD, newPassword: 'Changed-pass-1' },
    shownBody: '{\n  "currentPassword": "{{employeePassword}}",\n  "newPassword": "NewPassw0rd"\n}',
    expect: 200,
  });
  const relogin = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: mark.email, password: 'Changed-pass-1' });
  await exec({
    op: 'logout',
    folder: 'Sign out',
    name: 'Logout',
    method: 'post',
    path: '/auth/logout',
    auth: 'employee',
    body: { refreshToken: relogin.body.data.refreshToken },
    shownBody: '{\n  "refreshToken": "{{refreshToken}}"\n}',
    expect: 200,
  });

  // ------------------------------------------------------------------------------------------ Assemble
  const covered = new Set(captured.map((c) => c.op));
  const missing = [...operations.keys()].filter((op) => !covered.has(op));
  if (missing.length)
    throw new Error(`Operations in openapi.yaml without a documented request: ${missing.join(', ')}`);

  const items = new Map<string, Record<string, unknown>>();
  for (const c of captured.filter((x) => !x.exampleFor)) {
    items.set(c.name, {
      name: c.name,
      request: postmanRequest(c, describe(c)),
      response: [example(c, `${c.status} ${STATUS_TEXT[c.status] ?? ''}`.trim())],
      ...(c.test
        ? { event: [{ listen: 'test', script: { type: 'text/javascript', exec: c.test.split('\n') } }] }
        : {}),
      _folder: c.folder,
    });
  }
  for (const c of captured.filter((x) => x.exampleFor)) {
    const target = items.get(c.exampleFor!);
    if (!target) throw new Error(`exampleFor "${c.exampleFor}" not found`);
    (target.response as unknown[]).push(example(c, `${c.status} ${c.name}`));
  }

  const folders = FOLDERS.map(([name, description]) => ({
    name,
    description,
    item: [...items.values()]
      .filter((i) => i._folder === name)
      .map(({ _folder, ...rest }) => {
        void _folder;
        return rest;
      }),
  }));
  const unplaced = [...items.values()].filter((i) => !FOLDERS.some(([n]) => n === i._folder));
  if (unplaced.length)
    throw new Error(`Requests with an unknown folder: ${unplaced.map((i) => i.name).join(', ')}`);

  const collection = {
    info: {
      name: 'LEADS Attendance API',
      description: [
        spec.info.description.trim(),
        '',
        '**Using this collection**',
        '- Set `baseUrl` (e.g. `http://192.168.1.8:5000/api/v1` behind IIS, or `http://localhost:4000/api/v1`).',
        '- Fill in the `*Email` / `*Password` variables, then run a Login request: it stores the token',
        '  (`superAdminToken`, `adminToken` or `employeeToken`) that the other requests use.',
        '- Each request lists who may call it, every field, and every possible response. Open the saved examples',
        '  to see real responses (generated from the API itself; tokens replaced with placeholders).',
        '- IDs in paths and bodies are from the example data; replace them with IDs from your own responses.',
      ].join('\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:4000/api/v1' },
      { key: 'superAdminEmail', value: 'superadmin@leads-ndt.com' },
      { key: 'superAdminPassword', value: '' },
      { key: 'adminEmail', value: '' },
      { key: 'adminPassword', value: '' },
      { key: 'employeeEmail', value: '' },
      { key: 'employeePassword', value: '' },
      { key: 'superAdminToken', value: '' },
      { key: 'adminToken', value: '' },
      { key: 'employeeToken', value: '' },
      { key: 'refreshToken', value: '' },
    ],
    item: folders,
  };

  const out = 'docs/postman/LEADS-Attendance.postman_collection.json';
  fs.writeFileSync(out, JSON.stringify(collection, null, 2) + '\n');
  const requests = folders.reduce((n, f) => n + f.item.length, 0);
  const examples = folders.reduce(
    (n, f) => n + f.item.reduce((m, i) => m + (i.response as unknown[]).length, 0),
    0,
  );
  console.log(
    `Wrote ${out}: ${requests} requests, ${examples} saved examples, all ${operations.size} operations.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
    fs.rmSync(path.resolve(process.env.UPLOAD_DIR!), { recursive: true, force: true });
  });
