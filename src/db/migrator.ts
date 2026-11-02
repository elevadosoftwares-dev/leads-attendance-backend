import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sql from 'mssql';
import { buildDbConfig } from './pool';

type Log = (message: string) => void;

/** Locates db/migrations whether running from source (src/db) or from the build (dist/src/db). */
export function migrationsDir(): string {
  const candidates = [
    path.resolve(__dirname, '../../db/migrations'),
    path.resolve(__dirname, '../../../db/migrations'),
    path.resolve(process.cwd(), 'db/migrations'),
  ];
  const found = candidates.find((dir) => fs.existsSync(dir));
  if (!found) throw new Error(`db/migrations not found (looked in ${candidates.join(', ')})`);
  return found;
}

/** Splits a script into batches on lines containing only `GO`, as sqlcmd does. */
export function splitBatches(script: string): string[] {
  return script
    .split(/^\s*GO\s*;?\s*$/im)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** Creates the database if it doesn't exist (connects to master). */
export async function ensureDatabase(name: string): Promise<void> {
  const pool = await new sql.ConnectionPool(buildDbConfig('master')).connect();
  try {
    await pool.request().input('name', sql.NVarChar(128), name).query(`IF DB_ID(@name) IS NULL
         BEGIN
           DECLARE @sql NVARCHAR(400) = N'CREATE DATABASE ' + QUOTENAME(@name);
           EXEC sp_executesql @sql;
         END`);
  } finally {
    await pool.close();
  }
}

/** Drops and recreates a database. Refuses anything that isn't clearly a test database. */
export async function recreateTestDatabase(name: string): Promise<void> {
  if (!/_test$/i.test(name)) {
    throw new Error(`Refusing to drop "${name}": test database names must end with _test`);
  }
  const pool = await new sql.ConnectionPool(buildDbConfig('master')).connect();
  try {
    await pool
      .request()
      .input('name', sql.NVarChar(128), name)
      .query(
        `DECLARE @sql NVARCHAR(400);
         IF DB_ID(@name) IS NOT NULL
         BEGIN
           SET @sql = N'ALTER DATABASE ' + QUOTENAME(@name) + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE';
           EXEC sp_executesql @sql;
           SET @sql = N'DROP DATABASE ' + QUOTENAME(@name);
           EXEC sp_executesql @sql;
         END
         SET @sql = N'CREATE DATABASE ' + QUOTENAME(@name);
         EXEC sp_executesql @sql;`,
      );
  } finally {
    await pool.close();
  }
}

/**
 * Applies every `db/migrations/*.sql` file not yet recorded in `SchemaMigrations`, in filename order.
 * Each file runs in its own transaction; a checksum guards against edits to applied files.
 */
export async function runMigrations(database: string, log: Log = () => undefined): Promise<string[]> {
  await ensureDatabase(database);
  const pool = await new sql.ConnectionPool(buildDbConfig(database)).connect();
  const applied: string[] = [];
  try {
    await pool.request().query(`
      IF OBJECT_ID(N'dbo.SchemaMigrations', N'U') IS NULL
      CREATE TABLE dbo.SchemaMigrations (
        FileName   NVARCHAR(255) NOT NULL CONSTRAINT PK_SchemaMigrations PRIMARY KEY,
        Checksum   CHAR(64)      NOT NULL,
        AppliedUtc DATETIME2(0)  NOT NULL CONSTRAINT DF_SchemaMigrations_AppliedUtc DEFAULT SYSUTCDATETIME()
      );`);

    const done = await pool
      .request()
      .query<{ FileName: string; Checksum: string }>('SELECT FileName, Checksum FROM dbo.SchemaMigrations');
    const doneMap = new Map(done.recordset.map((r) => [r.FileName, r.Checksum]));

    const dir = migrationsDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const script = fs.readFileSync(path.join(dir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(script).digest('hex');
      const previous = doneMap.get(file);
      if (previous) {
        if (previous !== checksum) {
          log(`WARNING: ${file} has changed since it was applied; create a new migration instead.`);
        }
        continue;
      }

      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        for (const batch of splitBatches(script)) {
          await new sql.Request(tx).batch(batch);
        }
        await new sql.Request(tx)
          .input('file', sql.NVarChar(255), file)
          .input('checksum', sql.Char(64), checksum)
          .query('INSERT INTO dbo.SchemaMigrations (FileName, Checksum) VALUES (@file, @checksum)');
        await tx.commit();
      } catch (err) {
        await tx.rollback().catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
      log(`Applied ${file}`);
    }
    return applied;
  } finally {
    await pool.close();
  }
}
