import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rateLimitsTable } from './schemas/rate-limits.schema.js';
import type { RateLimitStore } from './rate-limit-store.js';

/**
 * Counters in a shared table. **Correct across replicas and across restarts.**
 *
 * Selected with `RATE_LIMIT_STORE=postgres`. Costs one upsert per guarded
 * request, and the guarded requests are login, registration, password reset and
 * verification — none of which is a hot path, and all of which already touch
 * the database in the same round trip.
 *
 * ## Why one statement, not three
 *
 * The obvious implementation reads the row, decides whether the window has
 * expired, then writes. Under concurrency that is broken in the exact scenario
 * the limiter exists for: two simultaneous attempts both read `count = 4`, both
 * conclude they are under a limit of 5, and both proceed — so the ceiling is
 * not 5 but 5 plus however many requests are in flight. An attacker sending
 * them in parallel is doing so by default, not by cleverness.
 *
 * `INSERT … ON CONFLICT DO UPDATE` performs the read, the decision and the
 * write as one atomic statement under a row lock. The window-expiry branch
 * moves into the SQL because it is part of that same decision.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  async hit(key: string, windowMs: number): Promise<{ count: number; windowStartedAt: number }> {
    // Milliseconds, not seconds. Rounding to whole seconds seemed harmless —
    // every real window here is fifteen minutes or an hour — but it made this
    // store disagree with the memory one below a second, which is where tests
    // live. Two stores behind one interface have to be substitutable at every
    // input, or the cheap one stops being able to prove anything about the
    // expensive one.
    const windowInterval = `${windowMs} milliseconds`;

    const rows = await db
      .insert(rateLimitsTable)
      .values({ key, count: 1, window_started_at: new Date() })
      .onConflictDoUpdate({
        target: rateLimitsTable.key,
        set: {
          // Restart the window, or continue it. `EXCLUDED` is the row this
          // statement tried to insert, so `EXCLUDED.window_started_at` is
          // "now" as computed above — using it rather than a second `now()`
          // keeps both branches on one timestamp.
          count: sql`CASE
            WHEN ${rateLimitsTable.window_started_at} < now() - (${windowInterval})::interval
            THEN 1
            ELSE ${rateLimitsTable.count} + 1
          END`,
          window_started_at: sql`CASE
            WHEN ${rateLimitsTable.window_started_at} < now() - (${windowInterval})::interval
            THEN excluded.window_started_at
            ELSE ${rateLimitsTable.window_started_at}
          END`,
        },
      })
      .returning({
        count: rateLimitsTable.count,
        windowStartedAt: rateLimitsTable.window_started_at,
      });

    const row = rows[0];
    // The upsert always returns a row. Defensive, and never expected — but
    // failing open here would silently disable the limiter, so it fails closed
    // by reporting a fresh window rather than by throwing into a login path.
    if (!row) return { count: 1, windowStartedAt: Date.now() };

    return { count: row.count, windowStartedAt: row.windowStartedAt.getTime() };
  }

  async reset(key: string): Promise<void> {
    await db.delete(rateLimitsTable).where(sql`${rateLimitsTable.key} = ${key}`);
  }

  async sweepExpired(windowMs: number): Promise<void> {
    const twoWindows = `${windowMs * 2} milliseconds`;
    // Two windows, matching the memory store — see `MemoryRateLimitStore`.
    //
    // Every replica runs this on its own timer, which is harmless: the delete
    // is idempotent, and the rows it targets are by definition ones nobody is
    // reading.
    await db
      .delete(rateLimitsTable)
      .where(
        sql`${rateLimitsTable.window_started_at} < now() - (${twoWindows})::interval`,
      );
  }
}
