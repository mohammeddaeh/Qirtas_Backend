/**
 * Creates the first Super Admin account from the CLI, so a fresh install no
 * longer has to stop mid-setup to start the server and hand-craft a
 * `POST /api/v1/users/bootstrap-super-admin` curl call.
 *
 * Same code path as that endpoint — it calls `usersService.bootstrapSuperAdmin`
 * after validating through the endpoint's own
 * `bootstrapSuperAdminBodySchema`, so the CLI can never create an account the
 * HTTP route would have rejected (root-protected flag, 100% ownership row and
 * Super Admin assignment all come from the service, not from here).
 *
 * Idempotent by the same rule the endpoint enforces: the service refuses to
 * run while any user row exists. This script checks first and logs a skip
 * instead of failing, so it is safe inside `npm run db:seed -- --admin` on an
 * already-populated database.
 *
 * Credentials come from env vars, all optional — the defaults are local-dev
 * values and must never be used for anything reachable from outside the
 * machine:
 *   SEED_ADMIN_FIRST_NAME  (default "Admin")
 *   SEED_ADMIN_LAST_NAME   (default "Qirtas")
 *   SEED_ADMIN_EMAIL       (default "super_admin@admin.com")
 *   SEED_ADMIN_PHONE       (default "0900000000")
 *   SEED_ADMIN_PASSWORD    (default "P@ssw0rd@123")
 */
import { bootstrapSuperAdminBodySchema } from '../../features/identity/dtos/users.dto.js';
import * as usersRepository from '../../features/identity/repositories/users.repository.js';
import * as usersService from '../../features/identity/services/users.service.js';
import { logger } from '../logger/logger.js';
import { DEMO_EMAIL_SUFFIX } from './seed-shared.js';

const DEFAULTS = {
  first_name: 'Admin',
  last_name: 'Qirtas',
  email: 'super_admin@admin.com',
  phone: '0900000000',
  password: 'P@ssw0rd@123',
} as const;

function resolveCredentials(): Record<string, string> {
  return {
    first_name: process.env.SEED_ADMIN_FIRST_NAME ?? DEFAULTS.first_name,
    last_name: process.env.SEED_ADMIN_LAST_NAME ?? DEFAULTS.last_name,
    email: process.env.SEED_ADMIN_EMAIL ?? DEFAULTS.email,
    phone: process.env.SEED_ADMIN_PHONE ?? DEFAULTS.phone,
    password: process.env.SEED_ADMIN_PASSWORD ?? DEFAULTS.password,
  };
}

/**
 * Creates the Super Admin when the `users` table is completely empty;
 * otherwise logs and returns without touching anything.
 */
export async function bootstrapSuperAdminIfMissing(): Promise<void> {
  const existingCount = await usersRepository.countAll();
  if (existingCount > 0) {
    logger.info(
      `Super Admin bootstrap skipped — ${existingCount} user row(s) already exist (bootstrap only runs on an empty users table)`,
    );
    return;
  }

  const raw = resolveCredentials();

  // The demo seed's `--reset` hard-deletes every user whose email ends with
  // this suffix. An admin created under it would be silently destroyed on the
  // next reset run, so refuse it outright instead of leaving a landmine.
  if (raw.email!.toLowerCase().endsWith(DEMO_EMAIL_SUFFIX)) {
    throw new Error(
      `SEED_ADMIN_EMAIL must not end with "${DEMO_EMAIL_SUFFIX}" — that suffix is hard-deleted by \`--demo --reset\`. Use a different domain (default: ${DEFAULTS.email}).`,
    );
  }

  const parsed = bootstrapSuperAdminBodySchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    throw new Error(
      `Invalid Super Admin credentials from SEED_ADMIN_* env vars: ${JSON.stringify(fieldErrors)}`,
    );
  }

  const user = await usersService.bootstrapSuperAdmin(parsed.data);
  logger.info(
    `Bootstrapped Super Admin: ${user.email} (id ${user.id}) — password from ${
      process.env.SEED_ADMIN_PASSWORD ? 'SEED_ADMIN_PASSWORD' : `default "${DEFAULTS.password}"`
    }`,
  );
}
