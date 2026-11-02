import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { closePool, getPool } from './db/pool';
import { startJobs } from './jobs';
import { createSocketServer } from './socket';
import { logger } from './utils/logger';

async function main() {
  await getPool();
  logger.info({ database: env.DB_NAME, server: env.DB_SERVER }, 'Connected to SQL Server');

  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  const stopJobs = env.ENABLE_CRON ? startJobs() : () => undefined;

  server.listen(env.PORT, () => {
    logger.info(`LEADS Attendance API listening on http://localhost:${env.PORT}/api/v1`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    stopJobs();
    void io.close();
    server.close(() => {
      closePool()
        .catch((err: unknown) => logger.error({ err }, 'Error closing DB pool'))
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
