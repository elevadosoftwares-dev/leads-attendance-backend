/* eslint-disable no-console */
/**
 * Seeds demo data so every screen of the mobile app has something to show.
 * Wipes all application tables first. Refuses to run in production unless --force is passed.
 *
 *   npm run seed
 */
import bcrypt from 'bcrypt';
import { env, isProduction } from '../src/config/env';
import { closePool, dateParam, getPool, sql } from '../src/db/pool';
import { haversineMeters } from '../src/utils/geo';
import {
  addDaysToWorkDate,
  combineWorkDateAndTime,
  computeIsLate,
  isWeekend,
  nextWorkDate,
  todayWorkDate,
  toWorkDate,
} from '../src/utils/time';

export const DEFAULT_PASSWORD = 'Leads@123';
const BCRYPT_COST = 12;

const OFFICE = {
  name: 'LEADS Office Geofence',
  address: '123 Aerospace Tech Park, Singapore',
  latitude: 1.417,
  longitude: 103.868,
  radiusMeters: 150,
};

const EMPLOYEE_NAMES = [
  'Mark Tan',
  'John Lim',
  'Sarah Lee',
  'David Ng',
  'Michelle Wong',
  'Kevin Chua',
  'Priya Nair',
  'Ahmad Rahman',
  'Rachel Goh',
  'Daniel Koh',
  'Siti Aminah',
  'Benjamin Ong',
  'Grace Teo',
  'Raj Kumar',
  'Jasmine Lau',
  'Marcus Yeo',
  'Nurul Huda',
  'Ethan Ho',
  'Chloe Low',
  'Samuel Sim',
  'Aisha Begum',
  'Jonathan Phua',
  'Vincent Seah',
  'Cheryl Foo',
  'Arjun Pillai',
  'Farhan Ismail',
  'Lucas Quek',
  'Melissa Chan',
];

const TASK_TITLES = [
  'Ultrasonic inspection: A320 main landing gear',
  'Eddy current inspection: B737 wheel hub',
  'Magnetic particle test: engine mount bracket',
  'Dye penetrant inspection: fan blade root',
  'Radiographic review: ATR 72 wing spar',
  'Calibrate UT flaw detector (Olympus EPOCH 650)',
  'Prepare NDT report for work order WO-',
  'Borescope inspection: CFM56 HPT stage 1',
  'Thickness survey: cargo door frame corrosion',
  'Bond testing: composite flap panel',
  'Update NDT Level II certification log',
  'Customer witness inspection prep',
  'Review inspection procedure NTM-',
  'Equipment daily check and reference standard verification',
];

const REPORT_SUMMARIES = [
  'Completed UT inspection on landing gear components; no rejectable indications found.',
  'Finished eddy current scans on wheel hubs and uploaded the inspection reports.',
  'Performed MPI on engine mount brackets; one linear indication recorded and escalated to QA.',
  'Calibrated flaw detector and verified reference blocks; all within tolerance.',
  'Supported customer witness inspection and closed out paperwork for two work orders.',
  'Borescope inspection completed; images attached to the task for engineering review.',
];

const BLOCKERS = [
  'Waiting for hangar slot to access aircraft.',
  'Couplant stock running low; requested reorder.',
  'Reference standard due for recalibration next week.',
];

/** Small deterministic PRNG (mulberry32) so the demo data is the same on every run. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(20261016);
const randInt = (min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const emailFor = (name: string) => `${name.toLowerCase().replace(/\s+/g, '.')}@leads-ndt.com`;
const hhmm = (minutesFromMidnight: number) =>
  `${String(Math.floor(minutesFromMidnight / 60)).padStart(2, '0')}:${String(minutesFromMidnight % 60).padStart(2, '0')}`;

/** A point roughly `meters` away from the office, in a random direction. */
function pointNearOffice(meters: number) {
  const angle = random() * 2 * Math.PI;
  const dLat = (meters * Math.cos(angle)) / 111_320;
  const dLng = (meters * Math.sin(angle)) / (111_320 * Math.cos((OFFICE.latitude * Math.PI) / 180));
  const lat = Number((OFFICE.latitude + dLat).toFixed(6));
  const lng = Number((OFFICE.longitude + dLng).toFixed(6));
  return { lat, lng, distance: haversineMeters(lat, lng, OFFICE.latitude, OFFICE.longitude) };
}

type Tx = sql.Transaction;

async function insertId(tx: Tx, query: string, bind: (r: sql.Request) => void): Promise<number> {
  const request = new sql.Request(tx);
  bind(request);
  const result = await request.query<{ id: number }>(query);
  return result.recordset[0]!.id;
}

async function wipe(tx: Tx) {
  const tables = [
    'DailyReports',
    'TaskAttachments',
    'Tasks',
    'Attendance',
    'Leaves',
    'Announcements',
    'DeviceTokens',
    'PasswordResets',
    'RefreshTokens',
    'Users',
    'Offices',
  ];
  for (const table of tables) {
    await new sql.Request(tx).batch(
      `DELETE FROM dbo.${table}; DBCC CHECKIDENT ('dbo.${table}', RESEED, 0) WITH NO_INFOMSGS;`,
    );
  }
}

interface SeedUser {
  id: number;
  name: string;
}

async function insertAttendance(
  tx: Tx,
  userId: number,
  workDate: string,
  clockIn: Date,
  clockOut: Date | null,
): Promise<number> {
  const inPoint = pointNearOffice(randInt(5, 120));
  const outPoint = pointNearOffice(randInt(5, 120));
  return insertId(
    tx,
    `INSERT INTO dbo.Attendance
       (UserId, WorkDate, ClockInUtc, ClockOutUtc, InLat, InLng, InAccuracy, InDistanceMeters,
        OutLat, OutLng, OutAccuracy, OutDistanceMeters, Method, IsLate)
     OUTPUT INSERTED.AttendanceId AS id
     VALUES (@userId, @workDate, @clockIn, @clockOut, @inLat, @inLng, @inAcc, @inDist,
             @outLat, @outLng, @outAcc, @outDist, N'GEOFENCE', @isLate)`,
    (r) =>
      r
        .input('userId', sql.Int, userId)
        .input('workDate', sql.Date, dateParam(workDate))
        .input('clockIn', sql.DateTime2(0), clockIn)
        .input('clockOut', sql.DateTime2(0), clockOut)
        .input('inLat', sql.Decimal(9, 6), inPoint.lat)
        .input('inLng', sql.Decimal(9, 6), inPoint.lng)
        .input('inAcc', sql.Decimal(9, 2), randInt(4, 30))
        .input('inDist', sql.Decimal(12, 2), inPoint.distance)
        .input('outLat', sql.Decimal(9, 6), clockOut ? outPoint.lat : null)
        .input('outLng', sql.Decimal(9, 6), clockOut ? outPoint.lng : null)
        .input('outAcc', sql.Decimal(9, 2), clockOut ? randInt(4, 30) : null)
        .input('outDist', sql.Decimal(12, 2), clockOut ? outPoint.distance : null)
        .input('isLate', sql.Bit, computeIsLate(clockIn, workDate, '09:00')),
  );
}

async function insertReport(tx: Tx, attendanceId: number, userId: number, submitted: Date) {
  await new sql.Request(tx)
    .input('attendanceId', sql.Int, attendanceId)
    .input('userId', sql.Int, userId)
    .input('summary', sql.NVarChar(2000), pick(REPORT_SUMMARIES))
    .input('blockers', sql.NVarChar(2000), random() < 0.25 ? pick(BLOCKERS) : null)
    .input('notes', sql.NVarChar(2000), random() < 0.2 ? 'Will continue tomorrow morning.' : null)
    .input('submitted', sql.DateTime2(0), submitted)
    .query(
      `INSERT INTO dbo.DailyReports (AttendanceId, UserId, Summary, Blockers, Notes, SubmittedUtc)
       VALUES (@attendanceId, @userId, @summary, @blockers, @notes, @submitted)`,
    );
}

interface TaskSeed {
  title: string;
  description: string;
  assigneeId: number;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'TODO' | 'IN_PROGRESS' | 'COMPLETED' | 'CARRIED_OVER';
  dueWorkDate: string;
  dueTime: string;
  completedUtc: Date | null;
  createdUtc: Date;
}

async function insertTask(tx: Tx, adminId: number, t: TaskSeed) {
  await new sql.Request(tx)
    .input('title', sql.NVarChar(200), t.title)
    .input('description', sql.NVarChar(4000), t.description)
    .input('assigneeId', sql.Int, t.assigneeId)
    .input('createdBy', sql.Int, adminId)
    .input('priority', sql.NVarChar(10), t.priority)
    .input('status', sql.NVarChar(20), t.status)
    .input('dueUtc', sql.DateTime2(0), combineWorkDateAndTime(t.dueWorkDate, t.dueTime))
    .input('dueWorkDate', sql.Date, dateParam(t.dueWorkDate))
    .input('completedUtc', sql.DateTime2(0), t.completedUtc)
    .input('createdUtc', sql.DateTime2(0), t.createdUtc)
    .query(
      `INSERT INTO dbo.Tasks (Title, Description, AssigneeId, CreatedBy, Priority, Status, DueUtc, DueWorkDate,
                              CompletedUtc, CreatedUtc, UpdatedUtc)
       VALUES (@title, @description, @assigneeId, @createdBy, @priority, @status, @dueUtc, @dueWorkDate,
               @completedUtc, @createdUtc, @createdUtc)`,
    );
}

function randomTaskTitle(): string {
  const title = pick(TASK_TITLES);
  if (title.endsWith('WO-')) return `${title}${randInt(24000, 24999)}`;
  if (title.endsWith('NTM-')) return `${title}${randInt(100, 399)}`;
  return title;
}

const randomPriority = (): TaskSeed['priority'] => pick(['LOW', 'MEDIUM', 'MEDIUM', 'HIGH'] as const);

async function seed() {
  const pool = await getPool();
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_COST);
  const now = new Date();
  const today = todayWorkDate();
  const tx = new sql.Transaction(pool);
  await tx.begin();

  try {
    await wipe(tx);

    const officeId = await insertId(
      tx,
      `INSERT INTO dbo.Offices (Name, Address, Latitude, Longitude, RadiusMeters)
       OUTPUT INSERTED.OfficeId AS id VALUES (@name, @address, @lat, @lng, @radius)`,
      (r) =>
        r
          .input('name', sql.NVarChar(150), OFFICE.name)
          .input('address', sql.NVarChar(300), OFFICE.address)
          .input('lat', sql.Decimal(9, 6), OFFICE.latitude)
          .input('lng', sql.Decimal(9, 6), OFFICE.longitude)
          .input('radius', sql.Int, OFFICE.radiusMeters),
    );

    const insertUser = (name: string, email: string, role: 'ADMIN' | 'EMPLOYEE') =>
      insertId(
        tx,
        `INSERT INTO dbo.Users (Name, Email, PasswordHash, Role, OfficeId, ShiftStart)
         OUTPUT INSERTED.UserId AS id VALUES (@name, @email, @hash, @role, @officeId, '09:00')`,
        (r) =>
          r
            .input('name', sql.NVarChar(150), name)
            .input('email', sql.NVarChar(254), email)
            .input('hash', sql.NVarChar(100), passwordHash)
            .input('role', sql.NVarChar(20), role)
            .input('officeId', sql.Int, officeId),
      );

    const adminId = await insertUser('Admin', 'admin@leads-ndt.com', 'ADMIN');
    const employees: SeedUser[] = [];
    for (const name of EMPLOYEE_NAMES) {
      employees.push({ id: await insertUser(name, emailFor(name), 'EMPLOYEE'), name });
    }

    // Leaves: two people on leave today, one past leave.
    const onLeaveToday = new Set([employees[6]!.id, employees[14]!.id]);
    const leaves = [
      {
        userId: employees[6]!.id,
        from: addDaysToWorkDate(today, -1),
        to: addDaysToWorkDate(today, 2),
        reason: 'Annual leave',
      },
      { userId: employees[14]!.id, from: today, to: today, reason: 'Medical appointment' },
      {
        userId: employees[20]!.id,
        from: addDaysToWorkDate(today, -9),
        to: addDaysToWorkDate(today, -8),
        reason: 'Family matters',
      },
    ];
    for (const leave of leaves) {
      await new sql.Request(tx)
        .input('userId', sql.Int, leave.userId)
        .input('from', sql.Date, dateParam(leave.from))
        .input('to', sql.Date, dateParam(leave.to))
        .input('reason', sql.NVarChar(500), leave.reason)
        .input('createdBy', sql.Int, adminId)
        .query(
          `INSERT INTO dbo.Leaves (UserId, FromDate, ToDate, Reason, CreatedBy)
           VALUES (@userId, @from, @to, @reason, @createdBy)`,
        );
    }
    const isOnLeave = (userId: number, date: string) =>
      leaves.some((l) => l.userId === userId && l.from <= date && date <= l.to);

    // Two weeks of history (weekdays only).
    let shifts = 0;
    let tasks = 0;
    for (let offset = 14; offset >= 1; offset--) {
      const date = addDaysToWorkDate(today, -offset);
      if (isWeekend(date)) continue;
      for (const emp of employees) {
        const present = !isOnLeave(emp.id, date) && random() < 0.93;
        let clockIn: Date | null = null;
        let clockOut: Date | null = null;
        if (present) {
          clockIn = combineWorkDateAndTime(date, hhmm(8 * 60 + 25 + randInt(0, 55)));
          clockOut = combineWorkDateAndTime(date, hhmm(17 * 60 + 30 + randInt(0, 80)));
          const attendanceId = await insertAttendance(tx, emp.id, date, clockIn, clockOut);
          await insertReport(tx, attendanceId, emp.id, clockOut);
          shifts++;
        }
        const count = randInt(1, 3);
        for (let i = 0; i < count; i++) {
          const done = present && random() < 0.85;
          await insertTask(tx, adminId, {
            title: randomTaskTitle(),
            description: 'Perform the inspection per the approved procedure and attach the signed report.',
            assigneeId: emp.id,
            priority: randomPriority(),
            status: done ? 'COMPLETED' : 'TODO',
            dueWorkDate: date,
            dueTime: hhmm(10 * 60 + randInt(0, 14) * 30),
            completedUtc: done ? new Date(clockIn!.getTime() + randInt(60, 420) * 60_000) : null,
            createdUtc: combineWorkDateAndTime(addDaysToWorkDate(date, -1), '16:00'),
          });
          tasks++;
        }
      }
    }

    // Today: a live mix of statuses for the admin dashboard.
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    for (const [index, emp] of employees.entries()) {
      if (onLeaveToday.has(emp.id)) continue;
      // Mark Tan stays clocked out so the clock-in flow can be demoed immediately.
      let scenario: 'none' | 'onTime' | 'late' | 'clockedOut';
      if (index === 0) scenario = 'none';
      else if (index === 1) scenario = 'onTime';
      else if (index === 2) scenario = 'late';
      else {
        const r = random();
        scenario = r < 0.68 ? 'onTime' : r < 0.8 ? 'late' : r < 0.88 ? 'clockedOut' : 'none';
      }
      if (scenario === 'none') continue;

      let clockIn = combineWorkDateAndTime(
        today,
        hhmm(scenario === 'late' ? 9 * 60 + randInt(12, 45) : 8 * 60 + 30 + randInt(0, 35)),
      );
      if (clockIn > now) clockIn = minutesAgo(randInt(5, 90));
      // Seeding just after midnight: don't create a shift that would fall on yesterday.
      if (toWorkDate(clockIn) !== today) continue;
      let clockOut: Date | null = null;
      if (scenario === 'clockedOut') {
        const candidate = new Date(clockIn.getTime() + randInt(240, 480) * 60_000);
        clockOut = candidate < now ? candidate : null;
      }
      const attendanceId = await insertAttendance(tx, emp.id, today, clockIn, clockOut);
      if (clockOut) await insertReport(tx, attendanceId, emp.id, clockOut);
      shifts++;
    }

    // Today's tasks.
    const mark = employees[0]!;
    const yesterdayCreated = combineWorkDateAndTime(addDaysToWorkDate(today, -1), '17:00');
    const markTasks: Omit<TaskSeed, 'assigneeId' | 'createdUtc'>[] = [
      {
        title: 'Client follow-up: SIA Engineering',
        description:
          'Call SIA Engineering QA to confirm the inspection schedule for next week and share the draft report.',
        priority: 'HIGH',
        status: 'TODO',
        dueWorkDate: today,
        dueTime: '11:00',
        completedUtc: null,
      },
      {
        title: 'Ultrasonic inspection: A320 main landing gear',
        description:
          'Perform UT on the MLG trunnion per NTM-212. Upload the signed inspection report when done.',
        priority: 'HIGH',
        status: 'IN_PROGRESS',
        dueWorkDate: today,
        dueTime: '15:00',
        completedUtc: null,
      },
      {
        title: 'Calibrate UT flaw detector (Olympus EPOCH 650)',
        description: 'Daily calibration against the IIW V1 block; record results in the equipment log.',
        priority: 'MEDIUM',
        status: 'COMPLETED',
        dueWorkDate: today,
        dueTime: '09:30',
        completedUtc: minutesAgo(30),
      },
      {
        title: 'Prepare NDT report for work order WO-24817',
        description:
          'Carried over from yesterday: compile findings and photos into the customer report template.',
        priority: 'MEDIUM',
        status: 'CARRIED_OVER',
        dueWorkDate: today,
        dueTime: '17:00',
        completedUtc: null,
      },
      {
        title: 'Update NDT Level II certification log',
        description: 'Log this month’s inspection hours towards Level II recertification.',
        priority: 'LOW',
        status: 'TODO',
        dueWorkDate: today,
        dueTime: '17:30',
        completedUtc: null,
      },
      {
        title: 'Eddy current inspection: B737 wheel hub',
        description: 'Scheduled for the next work day.',
        priority: 'MEDIUM',
        status: 'TODO',
        dueWorkDate: nextWorkDate(today),
        dueTime: '10:00',
        completedUtc: null,
      },
    ];
    for (const t of markTasks) {
      await insertTask(tx, adminId, { ...t, assigneeId: mark.id, createdUtc: yesterdayCreated });
      tasks++;
    }

    for (const emp of employees.slice(1)) {
      const count = randInt(2, 4);
      for (let i = 0; i < count; i++) {
        const r = random();
        const status: TaskSeed['status'] =
          i === 0 && random() < 0.2
            ? 'CARRIED_OVER'
            : r < 0.35
              ? 'COMPLETED'
              : r < 0.6
                ? 'IN_PROGRESS'
                : 'TODO';
        await insertTask(tx, adminId, {
          title: randomTaskTitle(),
          description: 'Perform the inspection per the approved procedure and attach the signed report.',
          assigneeId: emp.id,
          priority: randomPriority(),
          status,
          dueWorkDate: today,
          dueTime: hhmm(10 * 60 + randInt(0, 14) * 30),
          completedUtc: status === 'COMPLETED' ? minutesAgo(randInt(10, 120)) : null,
          createdUtc: yesterdayCreated,
        });
        tasks++;
      }
    }

    // Announcements.
    const announcements = [
      {
        title: 'Safety Briefing Tomorrow',
        body: 'All technicians must attend the radiation safety briefing at 08:30 in the main hangar. Bring your dosimeter badges and PPE.',
        category: 'SAFETY',
        pinned: true,
        daysAgo: 0,
      },
      {
        title: 'New Equipment Calibration',
        body: 'The new phased-array UT units have been calibrated and are available for booking from the equipment room. Please log every use.',
        category: 'GENERAL',
        pinned: false,
        daysAgo: 1,
      },
      {
        title: 'LEADS Family Day 2026',
        body: 'Join us for Family Day at Gardens by the Bay on Saturday, 28 November. Registration closes next Friday.',
        category: 'EVENTS',
        pinned: false,
        daysAgo: 2,
      },
      {
        title: 'Updated NDT Procedure Manual',
        body: 'Revision 14 of the NDT procedure manual is now in effect. Please review the changes to sections 4 and 7.',
        category: 'GENERAL',
        pinned: false,
        daysAgo: 6,
      },
      {
        title: 'Hangar 3 Access Restrictions',
        body: 'Hangar 3 is restricted to authorised personnel during the engine run-up tests this week.',
        category: 'SAFETY',
        pinned: false,
        daysAgo: 9,
      },
    ];
    for (const a of announcements) {
      const created = minutesAgo(a.daysAgo * 24 * 60 + 60);
      await new sql.Request(tx)
        .input('title', sql.NVarChar(200), a.title)
        .input('body', sql.NVarChar(sql.MAX), a.body)
        .input('category', sql.NVarChar(20), a.category)
        .input('pinned', sql.Bit, a.pinned)
        .input('createdBy', sql.Int, adminId)
        .input('created', sql.DateTime2(0), created)
        .query(
          `INSERT INTO dbo.Announcements (Title, Body, Category, IsPinned, CreatedBy, CreatedUtc, UpdatedUtc)
           VALUES (@title, @body, @category, @pinned, @createdBy, @created, @created)`,
        );
    }

    await tx.commit();
    console.log(
      `Seeded "${env.DB_NAME}": 1 office, 1 admin, ${employees.length} employees, ${shifts} shifts, ${tasks} tasks, ` +
        `${leaves.length} leaves, ${announcements.length} announcements.`,
    );
    console.log(
      `Logins (password ${DEFAULT_PASSWORD}): admin@leads-ndt.com, ${employees
        .slice(0, 3)
        .map((e) => emailFor(e.name))
        .join(', ')}, …`,
    );
  } catch (err) {
    await tx.rollback().catch(() => undefined);
    throw err;
  }
}

if (isProduction && !process.argv.includes('--force')) {
  console.error('Refusing to seed a production database (this wipes all data). Pass --force to override.');
  process.exit(1);
}

seed()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
