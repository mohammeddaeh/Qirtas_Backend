import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env.js';
import * as schema from './schema.js';

/**
 * **Sized and bounded** (2026-10-14). The defaults were 10 connections with no
 * wait limit: one print-queue page fanned out across all ten, and a till's
 * request queued behind it with no end. Twenty keeps several tills, boards
 * and phones moving (stay under Postgres `max_connections` across every
 * instance); a request that cannot get a connection in 5s fails instead of
 * hanging, and a runaway statement is cut at 60s (long enough for an import).
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  options: '-c statement_timeout=60000',
});

export const db = drizzle(pool, { schema });
