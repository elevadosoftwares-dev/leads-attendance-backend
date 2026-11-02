import type http from 'node:http';
import { Server } from 'socket.io';
import { env } from './config/env';
import { verifyAccessToken } from './modules/auth/token.service';
import { getLiveRow, getOverview } from './modules/admin/admin.service';
import { attachAdminNamespace } from './services/realtime.service';
import { logger } from './utils/logger';

/**
 * Socket.IO server for the live admin dashboard. Clients connect to the `/admin` namespace with
 * `auth: { token: <accessToken> }`; only ADMIN tokens are accepted.
 */
export function createSocketServer(server: http.Server): Server {
  const io = new Server(server, {
    cors: { origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false },
    serveClient: false,
  });

  const adminNs = io.of('/admin');
  adminNs.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token === '') throw new Error('UNAUTHORIZED');
      const user = verifyAccessToken(token);
      if (user.role !== 'ADMIN') return next(new Error('FORBIDDEN'));
      socket.data.user = user;
      next();
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'UNAUTHORIZED';
      next(new Error(code));
    }
  });
  adminNs.on('connection', (socket) => {
    logger.debug({ userId: socket.data.user?.id }, 'Admin dashboard connected');
  });

  attachAdminNamespace(adminNs, { liveRow: getLiveRow, overview: getOverview });
  return io;
}
