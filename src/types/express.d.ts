import type { Role } from '../modules/auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware from the verified access token. */
      user?: { id: number; role: Role };
    }
  }
}

export {};
