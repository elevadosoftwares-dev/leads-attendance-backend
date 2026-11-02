import sql from 'mssql';
import { env } from '../config/env';

export { sql };

/** Anything a query can run against: the shared pool or an open transaction. */
export type Queryable = sql.ConnectionPool | sql.Transaction;

export function buildDbConfig(database: string = env.DB_NAME): sql.config {
  return {
    server: env.DB_SERVER,
    // A named instance is resolved through SQL Browser, so the port must not be fixed.
    port: env.DB_INSTANCE ? undefined : env.DB_PORT,
    database,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: env.DB_ENCRYPT,
      trustServerCertificate: env.DB_TRUST_SERVER_CERT,
      instanceName: env.DB_INSTANCE,
      useUTC: true,
    },
  };
}

let poolPromise: Promise<sql.ConnectionPool> | null = null;

export function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    const pool = new sql.ConnectionPool(buildDbConfig());
    poolPromise = pool.connect().catch((err: unknown) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  const p = poolPromise;
  poolPromise = null;
  const pool = await p.catch(() => null);
  await pool?.close();
}

/** Creates a request bound to the given transaction, or to the shared pool. */
export async function createRequest(db?: Queryable): Promise<sql.Request> {
  if (db instanceof sql.Transaction) return new sql.Request(db);
  return new sql.Request(db ?? (await getPool()));
}

/**
 * Runs `fn` inside a transaction. Commits when it resolves, rolls back when it throws.
 * Requests in a transaction must run sequentially (await each one).
 */
export async function withTransaction<T>(fn: (tx: sql.Transaction) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  let rolledBack = false;
  tx.on('rollback', () => {
    rolledBack = true;
  });
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    // SQL Server may already have aborted the transaction; only roll back if it is still open.
    if (!rolledBack) {
      await tx.rollback().catch(() => undefined);
    }
    throw err;
  }
}

/** True for SQL Server unique-constraint (2627) and unique-index (2601) violations. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { number?: number; originalError?: { info?: { number?: number } } } | null;
  const num = e?.number ?? e?.originalError?.info?.number;
  return num === 2601 || num === 2627;
}

/** Converts a `YYYY-MM-DD` work date into the Date value mssql expects for a DATE parameter. */
export function dateParam(workDate: string): Date {
  return new Date(`${workDate}T00:00:00Z`);
}

/** Converts a DATE column value back to `YYYY-MM-DD`. */
export function fromDateColumn(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Converts a TIME column value back to `HH:mm`. */
export function fromTimeColumn(value: Date): string {
  return value.toISOString().slice(11, 16);
}

/** Builds `@prefix0, @prefix1, …` placeholders for an IN list and binds each value as an INT. */
export function bindIntList(request: sql.Request, prefix: string, values: number[]): string {
  return values
    .map((v, i) => {
      request.input(`${prefix}${i}`, sql.Int, v);
      return `@${prefix}${i}`;
    })
    .join(', ');
}
