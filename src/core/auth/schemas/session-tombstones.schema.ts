import { pgTable, serial, varchar, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { accountRealmEnum } from './account-emails.schema.js';

/**
 * Why a session was **ended on purpose** — kept after the session row is gone.
 *
 * ## The gap this closes (production_readiness.md §E10)
 *
 * A revoked session used to be deleted like an expired one, so the next
 * request with its token found nothing and answered a bare 401. The client
 * could only say "your session has ended" — to someone whose other device just
 * signed them out, whose password was just changed, or whose second factor an
 * administrator just reset. The last two are exactly the moments a person
 * should notice: "I did not do that" is how a stolen account is caught.
 *
 * ## Why the hash, and why it outlives nothing
 *
 * Keyed by the session's token hash (never the token), so a lookup for an
 * unknown bearer is one indexed probe. `expires_at` is the session's own hard
 * deadline: after it the token would have been "expired" anyway, so the
 * tombstone has nothing left to explain and the sweep removes it. Read, not
 * consumed — every retry with the same token gets the same honest answer.
 *
 * Not written for a deliberate sign-out (the device knows why) or for timeouts
 * (that IS "expired"). Suspension already answers with its own reason.
 */
export const sessionTombstonesTable = pgTable(
  'session_tombstones',
  {
    id: serial('id').primaryKey(),
    realm: accountRealmEnum('realm').notNull(),
    token_hash: varchar('token_hash', { length: 64 }).notNull(),
    /** `SessionRevokeReason` — why this device was signed out. */
    reason: varchar('reason', { length: 32 }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('session_tombstones_realm_hash_uq').on(t.realm, t.token_hash),
    index('session_tombstones_expires_idx').on(t.expires_at),
  ],
);
