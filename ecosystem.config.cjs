// PM2 process file for Linux hosting (see docs/deploy/linux-pm2.md). Run `npm run build` first, then:
//   pm2 start ecosystem.config.cjs && pm2 save
// Settings come from .env in this folder; only values PM2 must know are set here.
module.exports = {
  apps: [
    {
      name: 'leads-attendance-api',
      script: 'dist/src/server.js',
      // .env, secrets/ and uploads/ resolve relative to the working directory.
      cwd: __dirname,
      // One process only: the cron jobs and Socket.IO's in-memory rooms must not run twice.
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production' },
      // The server finishes in-flight requests for up to 10 s on SIGINT before exiting.
      kill_timeout: 12000,
      max_memory_restart: '512M',
      // Back off instead of restart-looping when SQL Server is unreachable at boot.
      exp_backoff_restart_delay: 1000,
      time: true,
      merge_logs: true,
    },
  ],
};
