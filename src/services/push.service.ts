import fs from 'node:fs';
import path from 'node:path';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging, type BatchResponse, type MulticastMessage } from 'firebase-admin/messaging';
import { env } from '../config/env';
import type { Role } from '../modules/auth/auth.types';
import * as devicesRepo from '../modules/devices/devices.repository';
import type { DeviceToken } from '../modules/devices/devices.repository';
import { logger } from '../utils/logger';

export interface PushMessage {
  title: string;
  body: string;
  /** String-only key/values delivered to the app (FCM requirement). */
  data?: Record<string, string>;
}

/** FCM error codes meaning the token will never work again and should be forgotten. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

const FCM_BATCH_SIZE = 500;

/** The subset of firebase-admin messaging we use (token-based multicast); swappable in tests. */
export interface MessagingClient {
  sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse>;
}

let client: MessagingClient | null | undefined;

function initClient(): MessagingClient | null {
  const credentialPath = env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!credentialPath) {
    logger.info('FIREBASE_SERVICE_ACCOUNT_PATH not set; push notifications are disabled (logged only)');
    return null;
  }
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(path.resolve(credentialPath), 'utf8'));
    const app: App = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
    return getMessaging(app);
  } catch (err) {
    logger.error({ err }, 'Failed to initialise Firebase; push notifications are disabled');
    return null;
  }
}

function getClient(): MessagingClient | null {
  if (client === undefined) client = initClient();
  return client;
}

/** Test hook: replace (or with `undefined`, reset) the messaging client. */
export function setMessagingClient(next: MessagingClient | null | undefined): void {
  client = next;
}

/**
 * Android channels created by the app: the default one plays the notification sound, the silent one doesn't. iOS
 * has no channels, so silent devices simply get no `sound`.
 */
export const ANDROID_CHANNEL = { sound: 'leads_default', silent: 'leads_silent' } as const;

async function sendToDevices(devices: DeviceToken[], message: PushMessage): Promise<void> {
  const tokens = (silent: boolean) => devices.filter((d) => d.silent === silent).map((d) => d.token);
  await sendToTokens(tokens(false), message, false);
  await sendToTokens(tokens(true), message, true);
}

async function sendToTokens(tokens: string[], message: PushMessage, silent: boolean): Promise<void> {
  const unique = [...new Set(tokens)];
  if (unique.length === 0) return;

  const messaging = getClient();
  if (!messaging) {
    logger.info(
      { title: message.title, recipients: unique.length, silent },
      'Push (disabled): would send notification',
    );
    return;
  }

  const dead: string[] = [];
  for (let i = 0; i < unique.length; i += FCM_BATCH_SIZE) {
    const batch = unique.slice(i, i + FCM_BATCH_SIZE);
    const response = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: {
        priority: 'high',
        notification: silent
          ? { channelId: ANDROID_CHANNEL.silent, defaultSound: false, defaultVibrateTimings: false }
          : { channelId: ANDROID_CHANNEL.sound, defaultSound: true },
      },
      apns: { payload: { aps: silent ? {} : { sound: 'default' } } },
    });
    response.responses.forEach((r, idx) => {
      if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) dead.push(batch[idx]!);
    });
    logger.info(
      { title: message.title, success: response.successCount, failure: response.failureCount, silent },
      'Push notification sent',
    );
  }
  if (dead.length > 0) {
    await devicesRepo.deleteTokens(dead);
    logger.info({ count: dead.length }, 'Removed unregistered FCM tokens');
  }
}

function fireAndForget(label: string, work: () => Promise<void>): Promise<void> {
  return work().catch((err: unknown) => {
    logger.error({ err }, `Push notification failed: ${label}`);
  });
}

/**
 * Push notifications are fire-and-forget: these never reject, so callers can `void` them without
 * risking the request. The returned promise exists for tests and jobs that want to await delivery.
 */
export const pushService = {
  notifyUsers(userIds: number[], message: PushMessage): Promise<void> {
    return fireAndForget(message.title, async () =>
      sendToDevices(await devicesRepo.listTokensForUsers(userIds), message),
    );
  },

  /** Every active user, or only those with one of `roles`. */
  notifyAllActive(message: PushMessage, roles?: readonly Role[]): Promise<void> {
    return fireAndForget(message.title, async () =>
      sendToDevices(await devicesRepo.listTokensForActiveUsers(roles), message),
    );
  },
};
