/* eslint-disable no-console */
/**
 * Creates an ACTIVE user from the command line, mainly to bootstrap the first admin:
 *   npm run user:create -- --name "Jane Lim" --email jane@leads-ndt.com --role ADMIN [--shift 09:00] [--password ...]
 * Without --password a random temporary password is generated and printed once.
 */
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { closePool } from '../src/db/pool';
import { createUserBody } from '../src/modules/users/users.schemas';
import { createUser } from '../src/modules/users/users.service';
import { AppError } from '../src/utils/AppError';

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      email: { type: 'string' },
      role: { type: 'string', default: 'EMPLOYEE' },
      shift: { type: 'string' },
      password: { type: 'string' },
    },
  });
  // Letters + digits, so it always satisfies the password rules.
  const generated = values.password ? null : `${crypto.randomBytes(9).toString('base64url')}a1`;
  const input = createUserBody.parse({
    name: values.name,
    email: values.email,
    role: values.role?.toUpperCase(),
    shiftStart: values.shift,
    password: values.password ?? generated,
  });
  // The command line is trusted like the super admin (it can create admins and set the shift start).
  const user = await createUser({ id: 0, role: 'SUPER_ADMIN' }, input);
  console.log(`Created ${user.role} #${user.id}: ${user.name} <${user.email}>, shift ${user.shiftStart}`);
  if (generated) console.log(`Temporary password (shown once): ${generated}`);
}

main()
  .catch((err: unknown) => {
    if (err instanceof AppError) console.error(`${err.code}: ${err.message}`);
    else if (err && typeof err === 'object' && 'issues' in err) {
      for (const i of (err as { issues: { path: unknown[]; message: string }[] }).issues) {
        console.error(`--${String(i.path[0] === 'shiftStart' ? 'shift' : i.path[0])}: ${i.message}`);
      }
    } else console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
