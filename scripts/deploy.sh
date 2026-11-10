#!/usr/bin/env bash
# Updates a Linux/PM2 install in place (see docs/deploy/linux-pm2.md). Run from the app folder as the app user:
#   ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
npm ci
npm run build
npm prune --omit=dev
npm run migrate:prod

if pm2 describe leads-attendance-api >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save
