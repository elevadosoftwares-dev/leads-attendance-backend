/* eslint-disable no-console */
import { env } from '../src/config/env';
import { runMigrations } from '../src/db/migrator';

async function main() {
  console.log(`Migrating database "${env.DB_NAME}" on ${env.DB_SERVER}…`);
  const applied = await runMigrations(env.DB_NAME, (m) => console.log(`  ${m}`));
  console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Database is up to date.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
