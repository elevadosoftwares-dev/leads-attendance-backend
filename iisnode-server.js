// Entry point for hosting under IIS with iisnode (see Web.config). Run `npm run build` first.
// iisnode starts Node in this file's folder only sometimes, so pin the working directory: .env, secrets/ and
// uploads/ are all resolved relative to it.
process.chdir(__dirname);
// iisnode adds X-Forwarded-For (enableXFF); trusting one hop gives each client its own rate-limit bucket.
if (!process.env.TRUST_PROXY) process.env.TRUST_PROXY = '1';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CommonJS so iisnode can load it
require('./dist/src/server.js');
