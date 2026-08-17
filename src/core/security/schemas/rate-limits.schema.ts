import { pgTable, varchar, integer, timestamp } from 'drizzle-orm/pg-core';

/**
 * Shared rate-limit counters, for deployments running more than one instance.
 *
 * Used only when `RATE_LIMIT_STORE=postgres`. The table exists in every
 * database regardless — an unused table costs nothing, and a migration that
 * has to be applied *before* scaling out is a migration that gets forgotten in
 * the hour it is needed.
 *
 * ## Why the key is the primary key
 *
 * There is exactly one row per counter, and the upsert in
 * `postgres-rate-limit-store.ts` depends on it: `ON CONFLICT (key)` is what
 * makes read-and-increment a single atomic statement. Two concurrent login
 * attempts must not both read "4 attempts" and both decide they are under the
 * limit — with a surrogate id and a separate uniqueness constraint that race is
 * available again.
 */
export const rateLimitsTable = pgTable('rate_limits', {
  /**
   * The counter's identity, e.g. `email:person@example.com` or `ip:10.0.0.1`.
   *
   * 320 characters: the maximum length of an email address (64 local + @ + 255
   * domain), which is the longest key any current limiter builds.
   */
  key: varchar('key', { length: 320 }).primaryKey(),

  count: integer('count').notNull().default(0),

  /**
   * When the current window opened. A fixed window, matching the memory store:
   * the limiter compares `now - window_started_at` against the configured span
   * and starts over once it is exceeded.
   */
  window_started_at: timestamp('window_started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RateLimitRow = typeof rateLimitsTable.$inferSelect;
