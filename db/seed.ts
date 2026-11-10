/* eslint-disable no-console */
/**
 * Resets the database to a clean install: one office and one SUPER_ADMIN account, nothing else.
 * Every other row and every uploaded file is deleted. Refuses to run in production unless --force is passed.
 *
 *   npm run seed
 *
 * The super admin comes from SUPERADMIN_NAME / SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD. Without a password a
 * random one is generated and printed once. The office starts with the values below; the super admin changes
 * them afterwards with PATCH /admin/office.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { env, isProduction } from '../src/config/env';
import { closePool, getPool, sql } from '../src/db/pool';
import { emailSchema, newPassword, personName } from '../src/modules/auth/auth.schemas';

const BCRYPT_COST = 12;

const OFFICE = {
  name: 'LEADS Office Geofence',
  address: '123 Aerospace Tech Park, Singapore',
  latitude: 1.417,
  longitude: 103.868,
  radiusMeters: 150,
  defaultShiftStart: '09:00',
  lateGraceMinutes: 10,
};

const TABLES = [
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

const superAdminSchema = z.object({
  name: personName,
  email: emailSchema,
  password: newPassword,
});

function superAdminFromEnv() {
  // Letters + digits, so a generated password always satisfies the password rules.
  const generated = process.env.SUPERADMIN_PASSWORD
    ? null
    : `${crypto.randomBytes(12).toString('base64url')}a1`;
  const parsed = superAdminSchema.safeParse({
    name: process.env.SUPERADMIN_NAME || 'Super Admin',
    email: process.env.SUPERADMIN_EMAIL || 'superadmin@leads-ndt.com',
    password: process.env.SUPERADMIN_PASSWORD || generated,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  - SUPERADMIN_${String(i.path[0]).toUpperCase()}: ${i.message}`,
    );
    throw new Error(`Invalid super admin settings:\n${issues.join('\n')}`);
  }
  return { ...parsed.data, generated };
}

async function seed() {
  const admin = superAdminFromEnv();
  const passwordHash = await bcrypt.hash(admin.password, BCRYPT_COST);
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();

  try {
    for (const table of TABLES) {
      await new sql.Request(tx).batch(
        `DELETE FROM dbo.${table}; DBCC CHECKIDENT ('dbo.${table}', RESEED, 0) WITH NO_INFOMSGS;`,
      );
    }

    const office = await new sql.Request(tx)
      .input('name', sql.NVarChar(150), OFFICE.name)
      .input('address', sql.NVarChar(300), OFFICE.address)
      .input('lat', sql.Decimal(9, 6), OFFICE.latitude)
      .input('lng', sql.Decimal(9, 6), OFFICE.longitude)
      .input('radius', sql.Int, OFFICE.radiusMeters)
      .input('shiftStart', sql.VarChar(5), OFFICE.defaultShiftStart)
      .input('grace', sql.Int, OFFICE.lateGraceMinutes)
      .query<{ id: number }>(
        `INSERT INTO dbo.Offices (Name, Address, Latitude, Longitude, RadiusMeters, DefaultShiftStart, LateGraceMinutes)
         OUTPUT INSERTED.OfficeId AS id
         VALUES (@name, @address, @lat, @lng, @radius, CAST(@shiftStart AS TIME(0)), @grace)`,
      );

    await new sql.Request(tx)
      .input('name', sql.NVarChar(150), admin.name)
      .input('email', sql.NVarChar(254), admin.email)
      .input('hash', sql.NVarChar(100), passwordHash)
      .input('officeId', sql.Int, office.recordset[0]!.id)
      .input('shiftStart', sql.VarChar(5), OFFICE.defaultShiftStart)
      .query(
        `INSERT INTO dbo.Users (Name, Email, PasswordHash, Role, OfficeId, ShiftStart, Status, IsActive)
         VALUES (@name, @email, @hash, N'SUPER_ADMIN', @officeId, CAST(@shiftStart AS TIME(0)), N'ACTIVE', 1)`,
      );

    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => undefined);
    throw err;
  }

  // Attachments belong to the tasks just deleted.
  const uploads = path.resolve(env.UPLOAD_DIR);
  for (const dir of ['attachments', 'tmp']) {
    fs.rmSync(path.join(uploads, dir), { recursive: true, force: true });
  }

  console.log(
    `Seeded "${env.DB_NAME}": 1 office ("${OFFICE.name}") and the super admin. All other data was removed.`,
  );
  console.log(`Super admin: ${admin.name} <${admin.email}>`);
  if (admin.generated) {
    console.log(
      `Generated password (shown once, set SUPERADMIN_PASSWORD to choose your own): ${admin.generated}`,
    );
  }
}

if (isProduction && !process.argv.includes('--force')) {
  console.error('Refusing to seed a production database (this wipes all data). Pass --force to override.');
  process.exit(1);
}

seed()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
