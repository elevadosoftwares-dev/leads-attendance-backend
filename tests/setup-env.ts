// Runs before every test file (before any app module is imported).
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.TEST_DB_NAME || `${process.env.DB_NAME ?? 'LeadsAttendance'}_test`;
process.env.UPLOAD_DIR = process.env.TEST_UPLOAD_DIR || './uploads-test';
process.env.ENABLE_CRON = 'false';
process.env.FIREBASE_SERVICE_ACCOUNT_PATH = '';
process.env.SMTP_HOST = '';
process.env.CLOCK_OUT_REQUIRES_GEOFENCE = 'false';
process.env.MAX_GPS_ACCURACY_METERS = '50';
process.env.APP_TIMEZONE = 'Asia/Singapore';
process.env.PUBLIC_BASE_URL = 'http://localhost:4000';
