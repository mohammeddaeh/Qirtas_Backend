import { pgTable, serial, integer, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { accountsTable } from './account-table.js';

/**
 * One row per signed-in device. Multiple concurrent sessions per account are
 * allowed, with no cap.
 *
 * ## Moved here from features/identity (2026-08-11)
 *
 * A session is not an identity concept — it belongs to whatever authenticated
 * it, and it is the one table this engine cannot function without. Keeping it
 * under `features/identity` meant `core/auth` would have had to reach into a
 * feature module for its own primary storage. The `users` reference above is
 * the single remaining crossing, and it is the same documented exception
 * `core/middleware/auth.ts` has always relied on: the FK must name a real
 * table, and the application owns that table.
 *
 * ## Why the token is stored hashed
 *
 * `token` used to hold the bearer credential in the clear. A dump of this
 * table — a backup, a read-replica, an exposed admin tool — therefore handed
 * the reader a working session for every signed-in user, no password required.
 * That is the same exposure the `password_hash` column exists to prevent, and
 * the reset-code path in this codebase already hashed its own short-lived
 * secret while this longer-lived one sat in plaintext beside it.
 *
 * SHA-256 rather than the password KDF: the token is 256 bits of CSPRNG output,
 * so there is nothing to brute-force and no salt to add — a slow KDF would only
 * add its cost to every single authenticated request. The same reasoning the
 * reset-code hash already documents.
 *
 * **Consequence, accepted deliberately**: existing sessions cannot be migrated
 * (the plaintext is what we no longer want to keep, and hashing it at migration
 * time would require reading it). Everyone signs in once more after deploy.
 */
export const sessionsTable = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => accountsTable.id, { onDelete: 'cascade' }),
    /**
     * SHA-256 of the bearer token, hex-encoded (64 chars).
     *
     * Unique so a lookup is a single indexed probe — the auth middleware runs
     * this on every authenticated request, which makes it the hottest query in
     * the system.
     */
    token_hash: varchar('token_hash', { length: 64 }).notNull().unique(),
    /**
     * Which mechanism proved the identity that opened this session —
     * `'local'`, and later `'google'`, `'keycloak'`.
     *
     * Recorded rather than assumed because "how did this device get in?" is a
     * question incident review asks first, and a column added afterwards can
     * only answer it for sessions opened afterwards.
     */
    provider: varchar('provider', { length: 32 }).notNull().default('local'),
    device_info: text('device_info'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    last_active_at: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When this token was last replaced by rotation.
     *
     * Distinct from `created_at`, which stays fixed at first sign-in: the
     * absolute lifetime is measured from creation, the rotation interval from
     * here. Collapsing them into one column would make a rotating session
     * immortal, defeating the absolute cap.
     */
    last_rotated_at: timestamp('last_rotated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Hard expiry, written at creation from the absolute-timeout policy.
     *
     * Stored rather than computed on read so that shortening the policy does
     * not retroactively kill live sessions, and lengthening it does not revive
     * dead ones. The row states its own deadline.
     */
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('sessions_user_idx').on(table.user_id),
    /** Supports the sweep of sessions past their hard deadline. */
    index('sessions_expires_idx').on(table.expires_at),
  ],
);

export type SessionRow = typeof sessionsTable.$inferSelect;
export type NewSessionRow = typeof sessionsTable.$inferInsert;
