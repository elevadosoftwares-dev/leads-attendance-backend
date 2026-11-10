import type { Namespace } from 'socket.io';
import { logger } from '../utils/logger';

/**
 * Pushes live updates to the `/admin` Socket.IO namespace.
 * Every emit is fire-and-forget: it never throws into, or delays, the request that triggered it.
 * Until `attachAdminNamespace` runs (e.g. in tests) every call is a no-op.
 */
let adminNs: Namespace | null = null;

export interface RealtimeBuilders {
  liveRow(userId: number): Promise<unknown | null>;
  overview(): Promise<unknown>;
}

let builders: RealtimeBuilders | null = null;

export const userRoom = (userId: number) => `user:${userId}`;

export function attachAdminNamespace(ns: Namespace, payloadBuilders: RealtimeBuilders): void {
  adminNs = ns;
  builders = payloadBuilders;
}

export function detachAdminNamespace(): void {
  adminNs = null;
  builders = null;
}

function run(label: string, fn: (ns: Namespace, b: RealtimeBuilders) => Promise<void>): void {
  const ns = adminNs;
  const b = builders;
  if (!ns || !b) return;
  fn(ns, b).catch((err: unknown) => logger.error({ err }, `Realtime emit failed: ${label}`));
}

export const realtime = {
  /** Emits `attendance:updated` for each user, then a fresh `overview:updated`. */
  attendanceChanged(...userIds: number[]): void {
    run('attendance', async (ns, b) => {
      for (const userId of userIds) {
        const row = await b.liveRow(userId);
        if (row) ns.emit('attendance:updated', row);
      }
      ns.emit('overview:updated', await b.overview());
    });
  },

  /** Emits `user:pending` when someone signs up and is waiting for approval. */
  userPending(user: unknown): void {
    run('user:pending', async (ns) => {
      ns.emit('user:pending', user);
    });
  },

  /** Emits `leave:updated` with the Leave whenever one is requested, reviewed, cancelled or withdrawn. */
  leaveChanged(leave: unknown): void {
    run('leave', async (ns) => {
      ns.emit('leave:updated', leave);
    });
  },

  /** Drops the dashboard connections of a user who lost admin access. */
  disconnectUser(userId: number): void {
    const ns = adminNs;
    if (ns) ns.in(userRoom(userId)).disconnectSockets(true);
  },

  /** Emits `task:updated` with TaskSummary + assignee for each task, then a fresh overview. */
  tasksChanged(tasks: unknown[]): void {
    run('tasks', async (ns, b) => {
      for (const task of tasks) ns.emit('task:updated', task);
      ns.emit('overview:updated', await b.overview());
    });
  },
};
