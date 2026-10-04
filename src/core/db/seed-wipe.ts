/**
 * Empties every business table — catalog, stock, pricing, promotions, sales,
 * orders, printing, documents, media — and keeps identity untouched.
 *
 * Two seed steps need it, for different reasons:
 *
 * - `--showcase` rebuilds the business data from scratch, so it starts from
 *   empty tables (and re-creates the reference data the wipe removed).
 * - `--demo --reset` hard-deletes the demo users and branches. Sales, stock and
 *   print jobs point at both with RESTRICT foreign keys, so the delete cannot
 *   happen while business rows still reference them.
 *
 * The list is "everything except KEEP", read from the database, so a table
 * added by a new migration is wiped without anyone remembering to list it —
 * and a new *identity* table has to be added to KEEP on purpose.
 *
 * Invoked by the orchestrator in `seed.ts`; never opens or closes the pool.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../logger/logger.js';

/** Tables that describe *who* — accounts, their access, sessions, languages. */
const KEEP = new Set([
  'users',
  'roles',
  'permissions',
  'role_permissions',
  'user_role_assignments',
  'branches',
  'ownerships',
  'audit_log_entries',
  'sessions',
  'session_tombstones',
  'auth_verification_tokens',
  'account_emails',
  'account_mfa',
  'account_mfa_recovery_codes',
  'authz_user_permission_overrides',
  'device_push_tokens',
  'customers',
  'customer_addresses',
  'customer_activity_log',
  'customer_sessions',
  'customer_verification_tokens',
  'languages',
  'translation_entries',
  'rate_limits',
]);

/** Audit rows about identity survive; rows about wiped records would name ids that no longer exist. */
const AUDIT_KEEP_PREFIXES = ['user', 'customer', 'email', 'branch', 'ownership', 'role', 'assignment'];

export async function wipeBusinessData(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('wipeBusinessData refuses to run with NODE_ENV=production');
  }
  const tables = (
    await db.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    )
  ).rows
    .map((r) => r.tablename)
    .filter((t) => !KEEP.has(t));

  // No CASCADE on purpose: if a kept table ever references a wiped one, the
  // truncate fails loudly instead of quietly emptying identity data with it.
  await db.execute(sql.raw(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY`));
  await db.execute(
    sql.raw(
      `DELETE FROM audit_log_entries WHERE split_part(target_entity, ':', 1) NOT IN (${AUDIT_KEEP_PREFIXES.map((p) => `'${p}'`).join(', ')})`,
    ),
  );

  // The media rows are gone, so their files on the local driver are orphans.
  if (env.STORAGE_DRIVER === 'local') {
    for (const dir of ['public/img', 'private/doc']) {
      const path = join(env.STORAGE_LOCAL_ROOT, dir);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
  }
  logger.info(`Wiped ${tables.length} business tables (identity kept)`);
}
