# Hosting on Linux with PM2 and SQL Server

These steps target **Ubuntu 22.04 LTS** (SQL Server 2022 supports it; Ubuntu 24.04 needs SQL Server 2025 or a
separate database server). The result is:

```
phone app ──https──> nginx :443 ──> Node (PM2, localhost:4000) ──> SQL Server :1433
```

Commands prefixed with `sudo` run as an admin user; the rest run as the `leads` app user created in step 2.

## 1. SQL Server

Skip to "Create the database login" if SQL Server already runs on another machine.

```bash
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | sudo gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg
curl -fsSL https://packages.microsoft.com/config/ubuntu/22.04/mssql-server-2022.list | sudo tee /etc/apt/sources.list.d/mssql-server-2022.list
sudo apt-get update && sudo apt-get install -y mssql-server
sudo /opt/mssql/bin/mssql-conf setup        # choose an edition (Express is free) and set the sa password
systemctl status mssql-server --no-pager

# Command-line client (sqlcmd)
curl -fsSL https://packages.microsoft.com/config/ubuntu/22.04/prod.list | sudo tee /etc/apt/sources.list.d/mssql-release.list
sudo apt-get update && sudo ACCEPT_EULA=Y apt-get install -y mssql-tools18 unixodbc-dev
echo 'export PATH="$PATH:/opt/mssql-tools18/bin"' >> ~/.bashrc && source ~/.bashrc
```

**Create the database login.** The API should not use `sa`. Create the database and a login that owns it:

```bash
sqlcmd -S localhost -U sa -C -Q "
CREATE DATABASE leads_attendance;
GO
CREATE LOGIN leads_app WITH PASSWORD = '<strong password>';
GO
USE leads_attendance;
CREATE USER leads_app FOR LOGIN leads_app;
ALTER ROLE db_owner ADD MEMBER leads_app;
GO"
```

Keep port 1433 closed to the internet. Open it only to the API server's IP if the database is on another machine.

**Moving the existing data** (optional). To keep the users, attendance and tasks from the current Windows
server, back up `leads_attendance` there (SSMS: *Tasks → Back Up…*), copy the `.bak` file to
`/var/opt/mssql/backup/` on the Linux server, and restore it:

```bash
sudo mkdir -p /var/opt/mssql/backup && sudo chown mssql: /var/opt/mssql/backup
sqlcmd -S localhost -U sa -C -Q "RESTORE FILELISTONLY FROM DISK = '/var/opt/mssql/backup/leads_attendance.bak'"
# Use the logical names printed above:
sqlcmd -S localhost -U sa -C -Q "RESTORE DATABASE leads_attendance FROM DISK = '/var/opt/mssql/backup/leads_attendance.bak'
  WITH MOVE '<data name>' TO '/var/opt/mssql/data/leads_attendance.mdf',
       MOVE '<log name>'  TO '/var/opt/mssql/data/leads_attendance_log.ldf', REPLACE"
```

Then create the `leads_app` user in it as above. If restoring brought an orphaned `leads_app` user with it,
relink it with `ALTER USER leads_app WITH LOGIN = leads_app`.

## 2. Node.js, PM2 and the app user

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential
sudo npm install -g pm2
sudo adduser --disabled-password --gecos "" leads
sudo -iu leads
```

## 3. Get the code

Either clone the repository:

```bash
git clone <repository url> ~/leads-attendance-api
cd ~/leads-attendance-api
```

or copy the project from a developer machine **without** `node_modules`, `dist`, `.env`, `uploads` and
`secrets`. For example:

```bash
rsync -av --exclude node_modules --exclude dist --exclude .env --exclude uploads --exclude secrets \
  ./ leads@<server>:~/leads-attendance-api/
```

Never copy `node_modules` from Windows: `bcrypt` is a native module and must be built on Linux by `npm ci`.

## 4. Configure

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Production values that differ from the example:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `4000` (nginx forwards to it) |
| `PUBLIC_BASE_URL` | `https://api.example.com` |
| `TRUST_PROXY` | `1` |
| `DB_SERVER` / `DB_NAME` | `localhost` (or the database server's host) / `leads_attendance` |
| `DB_USER` / `DB_PASSWORD` | `leads_app` / the password from step 1 |
| `DB_ENCRYPT` / `DB_TRUST_SERVER_CERT` | `true` / `true` for a local SQL Server with its self-signed certificate. Use `false` when the server has a trusted certificate. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Two new random values. Generate each with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `APP_TIMEZONE` | `Asia/Kolkata` (fallback only; the super admin's Office Settings value wins) |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | `./secrets/firebase-service-account.json` |
| `SMTP_*`, `MAIL_FROM` | The mail server, for password-reset emails |
| `ENABLE_CRON` | `true` |

Copy the Firebase service-account JSON securely (for example with `scp`) and lock it down:

```bash
mkdir -p secrets uploads && chmod 700 secrets
chmod 600 secrets/firebase-service-account.json
```

## 5. Build, migrate and start

```bash
npm ci
npm run build
npm prune --omit=dev
npm run migrate:prod                 # creates any missing tables; safe to re-run
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs leads-attendance-api --lines 50   # expect "Connected to SQL Server" and "listening"
curl -s http://localhost:4000/api/v1/health
```

**Only on a new, empty database** (not a restored one), create the office and the super admin. Set
`SUPERADMIN_NAME`, `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` in `.env` first, or leave the password empty
and note the one it prints:

```bash
npm run seed:prod -- --force      # --force: the seed refuses NODE_ENV=production otherwise
```

The seed **wipes all data**, so never run it again on a live server. Afterwards, remove `SUPERADMIN_PASSWORD`
from `.env`. Sign in as the super admin and set the office location, shift and timezone in Office Settings.
Add more admins from the app or with:

```bash
npm run user:create:prod -- --name "Jane Lim" --email jane@example.com --role ADMIN
```

**Start on boot.** Run `pm2 startup` as `leads`. It prints a `sudo env PATH=… pm2 startup systemd -u leads …`
command; run that command as an admin user, then run `pm2 save` again as `leads`.

**Rotate logs:**

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
```

## 6. nginx and HTTPS

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp /home/leads/leads-attendance-api/docs/deploy/nginx.conf /etc/nginx/sites-available/leads-attendance
sudo nano /etc/nginx/sites-available/leads-attendance           # set server_name
sudo ln -s /etc/nginx/sites-available/leads-attendance /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.example.com                          # needs DNS pointing at the server
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

Port 4000 stays closed to the outside, so only nginx reaches Node.

## 7. Point the app at the server

Build the app with the new address:

```bash
flutter build apk --release --dart-define=API_BASE_URL=https://api.example.com/api/v1
```

The default address is set in `lib/core/config/env.dart`.

## Updating

```bash
sudo -iu leads
cd ~/leads-attendance-api && ./scripts/deploy.sh
```

The script pulls, installs, builds, migrates, and reloads PM2. Back up the database before releases that add
migrations.

## Operations

| Task | Command |
| --- | --- |
| Status / memory | `pm2 status`, `pm2 monit` |
| Logs | `pm2 logs leads-attendance-api` |
| Restart after editing `.env` | `pm2 restart leads-attendance-api --update-env` |
| Nightly database backup | Run `sqlcmd -S localhost -U sa -C -Q "BACKUP DATABASE leads_attendance TO DISK='/var/opt/mssql/backup/leads_attendance.bak' WITH INIT"` from cron, and copy the file off the server |

Back up `uploads/` too, because the database stores only file keys.

Keep a **single** PM2 instance. `instances: 2` or cluster mode would run every cron job (shift reminders,
auto clock-out) twice. It would also split admin live updates across processes that don't share Socket.IO rooms.
