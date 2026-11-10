# LEADS Attendance API

Backend for **LEADS Attendance**, the workforce attendance and task app for LEADS (aerospace NDT, Singapore).
Employees clock in inside the office geofence, work through assigned tasks, upload inspection reports and clock
out by submitting a daily work report. Admins get a live dashboard, assign tasks, post announcements, correct
attendance and record leave.

The Flutter app consumes this API. The contract is in [`openapi.yaml`](openapi.yaml), and a runnable Postman
collection is in [`docs/postman/`](docs/postman/).

**Stack:** Node.js 20+ · TypeScript (strict) · Express 4 · SQL Server 2019+ (`mssql`, parameterized queries,
no ORM) · zod · JWT · Socket.IO · firebase-admin (FCM) · node-cron · vitest + supertest.

---

## Quick start

```bash
npm install
cp .env.example .env        # then fill in DB_* and the two JWT secrets
npm run migrate             # creates the database if needed and applies db/migrations/*.sql
npm run seed                # wipes everything, creates the office + super admin (refuses in production)
npm run dev                 # http://localhost:4000/api/v1  (watch mode)
```

Check it's up: `curl http://localhost:4000/api/v1/health`.

### SQL Server

Use any SQL Server 2019+ instance. You need a login that can create a database the first time
`npm run migrate` runs. For a throwaway local server:

```bash
docker compose up -d        # SQL Server 2022 Developer on localhost:1433, sa / Leads_Dev_Passw0rd!
```

Then set `DB_SERVER=localhost`, `DB_USER=sa`, `DB_PASSWORD=Leads_Dev_Passw0rd!`.
For a named instance (e.g. `SQLEXPRESS`), set `DB_INSTANCE` instead of relying on `DB_PORT`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the API with reload (tsx watch) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server (`dist/src/server.js`) |
| `npm run migrate` | Apply pending migrations (from source) |
| `npm run migrate:prod` | Apply pending migrations (from `dist/`, no dev dependencies needed) |
| `npm run seed` | **Delete all data** and create only the office and the super admin |
| `npm run user:create -- --name "Jane Lim" --email jane@leads-ndt.com --role ADMIN` | Create an active user (use it to make the first real admin). Optional `--shift 09:00`, `--password …`; without a password a temporary one is printed once. `user:create:prod` runs the compiled version |
| `npm test` | Integration and unit tests against a real SQL Server test database |
| `npm run lint` | ESLint and Prettier check |
| `npm run format` | Prettier write |
| `npm run docs:postman` | Regenerate the Postman documentation (runs every endpoint against the test database) |

## Environment variables

Validated with zod at startup (`src/config/env.ts`); the process exits with a list of problems if anything is
invalid. See [`.env.example`](.env.example) for the full annotated list.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | |
| `PUBLIC_BASE_URL` | `http://localhost:4000` | Used to build attachment URLs |
| `CORS_ORIGINS` | – | Comma-separated browser origins. Mobile apps send no `Origin` and are always allowed |
| `TRUST_PROXY` | `0` | Number of proxies in front (set to `1` behind IIS/nginx so rate limiting sees real client IPs) |
| `DB_SERVER`, `DB_PORT`, `DB_INSTANCE`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | | `DB_NAME` defaults to `LeadsAttendance` |
| `DB_ENCRYPT` / `DB_TRUST_SERVER_CERT` | `true` / `false` | Only trust self-signed certificates in development |
| `TEST_DB_NAME` | `${DB_NAME}_test` | **Dropped and recreated** by `npm test`; must end with `_test` |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | | At least 32 characters each |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `15m` / `30d` | |
| `APP_TIMEZONE` | `Asia/Singapore` | Fallback company timezone; the super admin sets the real one in office settings |
| `MAX_GPS_ACCURACY_METERS` | `50` | |
| `CLOCK_OUT_REQUIRES_GEOFENCE` | `false` | |
| `UPLOAD_DIR` / `MAX_UPLOAD_MB` | `./uploads` / `10` | |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | – | Path to a service-account JSON. When unset, push is a logged no-op |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | – | When `SMTP_HOST` is unset, reset links are logged to the console |
| `SUPERADMIN_NAME`, `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` | `Super Admin`, `superadmin@leads-ndt.com`, – | Used only by `npm run seed`. Empty password: one is generated and printed |
| `PASSWORD_RESET_URL` | `${PUBLIC_BASE_URL}/reset-password` | Base of the link in reset emails (`?token=` is appended); point it at the app's deep link |
| `ENABLE_CRON` | `true` | Run the background jobs in this process (disable on all but one instance) |
| `LOG_LEVEL` | `info` | |

## Seed: the super admin

`npm run seed` resets the database to a clean install. It **deletes every row and every uploaded file**, then
creates exactly two things:

- **The office** "LEADS Office Geofence", 123 Aerospace Tech Park, at 1.4170, 103.8680, radius 150 m, default shift
  start 09:00, 10 minutes late grace. The super admin changes these afterwards with `PATCH /admin/office`.
- **The super admin**, from `SUPERADMIN_NAME`, `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` in `.env`. If
  `SUPERADMIN_PASSWORD` is empty, a random password is generated and printed once.

There is no demo data. Everyone else is added through the API: the super admin creates admins, admins create or
approve employees, and employees can sign up from the app.

## Roles

| Role | Can do |
|---|---|
| `EMPLOYEE` | Clock in and out, own tasks, attachments, announcements, own history |
| `ADMIN` | Everything under `/admin` for employees: dashboard, tasks, announcements, manual attendance, reports, leave (record, approve, reject, cancel), employee accounts (create, approve or reject sign-ups, rename, remove, reactivate). Can **read** the office settings |
| `SUPER_ADMIN` | Everything an admin can do, plus: **change the office settings** (name, address, location, geofence radius, default shift start and end, late grace minutes, timezone), **set anyone's shift start and end**, and **create, promote, demote or remove admins** |

There is one super admin, created by the seed. Nobody can create, change or remove it through the API, except
renaming itself. When an admin tries a super-admin-only action, the API answers `403 FORBIDDEN`.

## API overview

Base URL `/api/v1`. Every response uses the envelope `{ success, data }` or
`{ success: false, error: { code, message, details } }`. The full contract, with every field, enum and error
code, is in [`openapi.yaml`](openapi.yaml). `tests/contract.test.ts` fails if any path in it is missing from the
app.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup`, `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password` |
| Me | `GET /me`, `POST /me/device-token`, `GET /me/today`, `POST /me/change-password`, `GET/POST /me/leaves`, `POST /me/leaves/:id/withdraw` |
| Attendance | `POST /attendance/clock-in`, `GET /attendance/current`, `POST /attendance/clock-out`, `GET /attendance/history?month=` |
| Tasks | `GET /tasks?date=`, `GET /tasks/:id`, `PATCH /tasks/:id/status`, `POST /tasks/:id/attachments`, `GET /files/:attachmentId` |
| Announcements | `GET /announcements`, `GET /announcements/:id` |
| Admin | `/admin/tasks` (CRUD + `/stats`), `/admin/announcements` (CRUD), `GET /admin/overview`, `GET /admin/attendance/live`, `/admin/users` (list by status, create, `PATCH`, `DELETE` = remove, `/:id/approve`, `/:id/reject`, `/:id/reactivate`), `GET /admin/office` (any admin), `PATCH /admin/office` (super admin only), `POST /admin/attendance/manual`, `GET /admin/reports`, `POST/GET /admin/leaves` (`?status=` or `?date=`), `POST /admin/leaves/:id/approve` / `reject` / `cancel` |
| Real-time | Socket.IO namespace `/admin` (`auth: { token }`, ADMIN only): `attendance:updated`, `overview:updated`, `task:updated`, `user:pending`, `leave:updated` |
| Ops | `GET /health` (checks DB connectivity; 503 when the DB is down) |

### Accounts: sign-up, approval and removal

- **Status:** every user is `PENDING`, `ACTIVE` or `INACTIVE`.
- **Employees sign up themselves** with `POST /auth/signup`. The account is `PENDING` and login returns
  `403 ACCOUNT_PENDING` until an admin approves it (`POST /admin/users/:id/approve`, optionally with `shiftStart`).
  Admins get a `USER_PENDING` push and a `user:pending` socket event. Rejecting deletes the sign-up.
- **Admins are never self-registered.** Only the super admin creates them (`POST /admin/users` with `role: ADMIN`, or
  promotes an employee with `PATCH`). `npm run user:create` can also create one from the server.
- **Removing** (`DELETE /admin/users/:id`) deactivates rather than deletes, so attendance, tasks and reports are kept.
  It takes effect immediately: existing access tokens stop working, refresh tokens are revoked, push devices are
  forgotten, and login returns `403 ACCOUNT_INACTIVE`. Requests with a token issued before the removal, and refreshes, answer `401 ACCOUNT_INACTIVE`, so
  clients can end the session and say why. `POST /admin/users/:id/reactivate` restores the account.
- **Guards:** admins manage employees only; only the super admin manages admins; nobody can remove themselves or
  change their own role; the super admin account cannot be changed by anyone else.
- **Shift times:** new users get the office `defaultShiftStart` and `defaultShiftEnd`. Only the super admin can give
  someone different ones; the end must be later than the start (shifts don't cross midnight). Lateness uses the start.
- **Role changes** apply at once, because every request re-reads the account's role and status from the database.

### Behaviour worth knowing on the client side

These are decisions the contract left open. They are documented in `openapi.yaml` too.

- **Create endpoints return `201`** (clock-in, admin create task / announcement / manual attendance / leave).
  All other successes are `200`.
- **Validation errors** list the failing fields: `details: { fields: [{ field, message }] }`.
- **Clock-out location:** `MOCK_LOCATION` and `LOW_ACCURACY` are always enforced. The geofence is enforced only when
  `CLOCK_OUT_REQUIRES_GEOFENCE=true`. The position is always recorded.
- **One shift per day:** clocking in again after clocking out on the same SG date returns `409 ALREADY_CLOCKED_IN`.
- **Task status moves** are strict: `TODO`/`CARRIED_OVER → IN_PROGRESS → COMPLETED`. Anything else is
  `400 VALIDATION_ERROR` with `details.currentStatus`.
- **Carry-over** moves a task to the same local time on the next **weekday** (Friday carries to Monday).
- **Attachments:** pdf, jpg/jpeg, png, docx and xlsx only, up to 10 MB. The extension, MIME type and file signature
  must agree. Download through the attachment's `url` with the bearer token. Files are never served statically.
- **Reset-password** with a bad or expired token returns `400 VALIDATION_ERROR` (field `token`).
- **Leave:** an admin records leave as `APPROVED`; an employee requests it from today on as `PENDING`, and an admin
  approves or rejects it. Only approved leave counts as on leave (dashboard, live status, shift reminder, history).
  Admins can cancel leave that hasn't ended; employees can withdraw pending leave, or approved leave before it starts.
  Leave overlapping pending or approved leave of the same employee returns `400 VALIDATION_ERROR`.
  **Overlapping manual attendance** returns `409 ALREADY_CLOCKED_IN`.
- **Logout then refresh:** presenting a revoked refresh token is treated as token reuse, so all of that user's
  refresh tokens are revoked.
- **Sign-up rate limit:** 5 per 15 minutes per IP + email, and 20 per hour per IP.
- **Login rate limit:** 5 attempts per 15 minutes per IP + email. Repeated test runs with the same account will hit
  it. Restart the server to clear it in development, since limits are kept in memory.

## Project layout

```
src/
  app.ts               Express app (no listen), used by tests
  server.ts            HTTP server + Socket.IO + cron bootstrap, graceful shutdown
  socket.ts            /admin namespace with JWT handshake auth
  config/env.ts        zod-validated environment
  db/                  pool.ts (pool, withTransaction, helpers), migrator.ts
  middleware/          auth, requireRole, validate, upload, errorHandler, notFound
  services/            push (FCM), storage (StorageService interface + local disk), mail, realtime
  modules/<feature>/   *.routes → *.controller (thin) → *.service (rules) → *.repository (all SQL)
  jobs/                shift reminder (08:45 Mon–Fri), auto clock-out (23:59 daily), both in SG time
  utils/               geo (haversine), time (SG helpers), AppError, apiResponse, logger
db/migrations/         001_init.sql …   (applied files are recorded in dbo.SchemaMigrations)
db/seed.ts             clean install: office + super admin
scripts/               migrate.ts, create-user.ts, build-postman.ts, deploy.sh
tests/                 integration tests per module + unit tests
```

To add a schema change, create the next numbered file (`002_….sql`) and never edit an applied one. The runner
warns if an applied file's checksum changes. Separate batches with `GO` lines, as in sqlcmd.

## Testing

```bash
npm test
```

Tests run against a real SQL Server. `TEST_DB_NAME` (default `<DB_NAME>_test`) is **dropped, recreated and
migrated** at the start of every run, and each test resets its own data. The runner refuses to drop a database
whose name doesn't end in `_test`. Uploads go to `./uploads-test`, which is removed afterwards.

Coverage includes the geofence order (mocked, then accuracy, then distance), boundary distances, race-safe
double clock-in, lateness at exactly the grace boundary, SG-date edge cases, clock-out rollback, ownership,
carry-over, history stats, admin overview and live statuses, manual attendance overlap, Socket.IO auth and
events, push token cleanup, both cron jobs, and the OpenAPI contract.

### Postman

[`docs/postman/LEADS-Attendance.postman_collection.json`](docs/postman/LEADS-Attendance.postman_collection.json)
documents every endpoint. Import it into Postman and open **View documentation**.

- **What each request shows:** who can call it, its path and query parameters, a table of every body field with
  its rules, and every possible response.
- **Saved examples:** these are real responses, including error cases such as an admin trying a
  super-admin-only action. Tokens are replaced with placeholders.
- **Generating it:** `npm run docs:postman` rebuilds the collection. It runs every request against a fresh
  copy of the **test** database, so your real data is never touched. It fails if any operation in
  `openapi.yaml` is missing.
- **Using it:** set `baseUrl`, fill in the email and password variables, and run a Login request. Login stores
  the token that the other requests use.

## Security notes

- Access tokens carry only `{ sub, role }` (HS256, 15 min). Refresh tokens are 64 random bytes stored only as
  SHA-256 HMAC hashes, keyed with `JWT_REFRESH_SECRET`. They rotate on every refresh, and reusing a rotated or
  revoked token revokes every session for that user. A password reset also signs out all devices.
- Login compares passwords in constant time, using a dummy bcrypt hash for unknown emails. Unknown emails and
  wrong passwords return the same `INVALID_CREDENTIALS`; only with the correct password does a pending or removed
  account answer `403 ACCOUNT_PENDING` / `ACCOUNT_INACTIVE`. Passwords use bcrypt cost 12.
- Every authenticated request (and every `/admin` socket handshake) re-checks the account in the database, so a
  removed or demoted user loses access at once instead of when their token expires.
- `requireRole('ADMIN')` guards the entire `/admin` router. Every body, query and param is validated with zod.
  Every query is parameterized.
- The app uses helmet, a CORS allow-list and a 1 MB JSON limit. The central error handler never returns stack
  traces in production, and logs redact authorization headers, passwords and tokens.

## Deployment

Build once, then run `node dist/src/server.js` with `NODE_ENV=production` and a production `.env` (or real
environment variables). Apply migrations as a release step with `npm run migrate:prod`. Run the cron jobs on
**one** instance only: set `ENABLE_CRON=false` on the others. Socket.IO with several instances needs sticky
sessions plus a Socket.IO adapter (e.g. Redis); a single instance needs neither.

Put `UPLOAD_DIR` on persistent storage. To move files to Azure Blob Storage, implement `StorageService` in
`src/services/storage.service.ts` (the database stores only opaque keys) and swap the exported `storage`.

### Linux server with PM2

[`docs/deploy/linux-pm2.md`](docs/deploy/linux-pm2.md) covers a full Ubuntu setup: SQL Server, Node 20,
PM2 with [`ecosystem.config.cjs`](ecosystem.config.cjs) (one instance, so the cron jobs and Socket.IO stay
correct), nginx with HTTPS from [`docs/deploy/nginx.conf`](docs/deploy/nginx.conf), and updates with
[`scripts/deploy.sh`](scripts/deploy.sh).

### Linux container

A [`Dockerfile`](Dockerfile) is included:

```bash
docker build -t leads-attendance-api .
docker run -d -p 4000:4000 --env-file .env.production \
  -v leads-uploads:/app/uploads leads-attendance-api
docker run --rm --env-file .env.production leads-attendance-api node dist/scripts/migrate.js
```

Put it behind a TLS-terminating proxy (nginx, Azure App Service, AWS ALB). Set `TRUST_PROXY=1`, allow WebSocket
upgrades on `/socket.io/`, and set `PUBLIC_BASE_URL` to the public https origin.

### Windows Server / IIS

**Recommended: IIS as a reverse proxy** to the Node process. This supports WebSockets fully and keeps Node
supervised as a service.

1. Install Node 20 LTS, the IIS **URL Rewrite** and **Application Request Routing (ARR)** modules, and the
   **WebSocket Protocol** feature. In ARR, enable proxying.
2. `npm ci && npm run build && npm prune --omit=dev`, then run `node dist/src/server.js` as a Windows service
   (e.g. with [NSSM](https://nssm.cc) or WinSW), with the working directory set to the app folder.
3. Use [`docs/deploy/web.config.reverse-proxy`](docs/deploy/web.config.reverse-proxy) as the site's
   `web.config`. It forwards everything to `http://localhost:4000`. Set `TRUST_PROXY=1`.

**Alternative: iisnode.** [`docs/deploy/web.config.iisnode`](docs/deploy/web.config.iisnode) runs
`dist/src/server.js` under iisnode. iisnode supplies the port through `PORT` (a named pipe), which the app
accepts. iisnode doesn't proxy WebSockets, so the admin dashboard falls back to Socket.IO long-polling. It also
recycles processes, so set `ENABLE_CRON=false` there and run the jobs from a separate always-on instance.

## Notes

- All timestamps are stored in UTC (`DATETIME2(0)`, whole seconds). "Today", work dates, lateness, due times and
  cron schedules always use the company timezone (the office's `timezone`, set by the super admin; `APP_TIMEZONE`
  until the office is read), never the server's local time. The app shows times in the `timezone` from the profile.
- Durations come from `DATEDIFF(MINUTE, ClockInUtc, ClockOutUtc)` on the server.
