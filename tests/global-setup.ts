// Runs once per `vitest run`: recreates the test database and applies all migrations.
// setup-env must be imported first: it points DB_NAME at the test database before env.ts loads.
import './setup-env';
import fs from 'node:fs';
import path from 'node:path';
import { recreateTestDatabase, runMigrations } from '../src/db/migrator';

export default async function setup() {
  const testDb = process.env.DB_NAME!;
  await recreateTestDatabase(testDb);
  await runMigrations(testDb);

  return () => {
    fs.rmSync(path.resolve(process.env.UPLOAD_DIR!), { recursive: true, force: true });
  };
}
