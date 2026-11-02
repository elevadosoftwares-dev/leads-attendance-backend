import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const duration = z.string().regex(/^\d+[smhd]$/, 'must look like 15m, 12h or 30d');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:4000')
    .transform((v) => v.replace(/\/+$/, '')),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DB_SERVER: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(1433),
  DB_INSTANCE: optionalString,
  DB_NAME: z.string().min(1).default('LeadsAttendance'),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_ENCRYPT: bool(true),
  DB_TRUST_SERVER_CERT: bool(false),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ACCESS_TTL: duration.default('15m'),
  JWT_REFRESH_TTL: duration.default('30d'),

  APP_TIMEZONE: z.string().default('Asia/Singapore'),
  LATE_GRACE_MINUTES: z.coerce.number().int().min(0).default(10),
  MAX_GPS_ACCURACY_METERS: z.coerce.number().positive().default(50),
  CLOCK_OUT_REQUIRES_GEOFENCE: bool(false),

  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),

  FIREBASE_SERVICE_ACCOUNT_PATH: optionalString,

  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: z.string().default('LEADS Attendance <no-reply@leads-ndt.com>'),
  PASSWORD_RESET_URL: optionalString,

  ENABLE_CRON: bool(true),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.APP_TIMEZONE });
  } catch {
    console.error('Invalid environment configuration:\n  - APP_TIMEZONE: unknown time zone');
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
