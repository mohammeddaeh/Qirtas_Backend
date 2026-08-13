import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';
import { accountsTable } from './account-table.js';

/**
 * What a token proves. Both purposes need identical machinery — issue, hash,
 * expire, count attempts, consume once — and differ only in what succeeding
 * grants, so they share one table rather than two identical ones.
 */
export const verificationPurposeEnum = pgEnum('verification_purpose', [
  'email_verify',
  'password_reset',
]);

/**
 * Short-lived, single-use proofs sent to an email address.
 *
 * ## Why a table, when password reset already worked without one
 *
 * The previous design kept `password_reset_token` and
 * `password_reset_expires_at` as two columns on `users`. That works for exactly
 * one token type and cannot express three things this flow needs:
 *
 * 1. **A per-code attempt counter.** Without it the only guessing limit is the
 *    per-IP rate limiter, which an attacker with a pool of addresses never
 *    fills — so the code was defended by nothing that survives IP rotation.
 *    `attempts` binds the limit to the code itself, which is what lets the code
 *    be six digits rather than long enough to survive unlimited guessing.
 * 2. **A second purpose.** Email verification would have needed two more
 *    columns on `users`, and a third purpose two more again.
 * 3. **A consumed-but-retained row.** Deleting on use erases the evidence that
 *    a reset happened; `consumed_at` keeps the fact and still refuses reuse.
 *
 * ## Why the code is stored hashed
 *
 * A verification code is a temporary password: for its lifetime it is
 * sufficient to take over an account. Storing it in the clear means a leak of
 * this table hands the reader every account with a flow in progress — the exact
 * exposure `password_hash` exists to prevent.
 *
 * SHA-256, not the password KDF: the value is high-entropy and lives fifteen
 * minutes, so a slow salted hash buys no meaningful resistance and adds its
 * cost to every verification attempt.
 */
export const verificationTokensTable = pgTable(
  'auth_verification_tokens',
  {
    id: serial('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => accountsTable.id, { onDelete: 'cascade' }),
    purpose: verificationPurposeEnum('purpose').notNull(),
    /** SHA-256 of the code, hex-encoded. The plaintext exists only in the email. */
    token_hash: varchar('token_hash', { length: 64 }).notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Set the moment the code succeeds, in the same write that applies its
     * effect. A code that outlives its own use is a second, permanent password.
     */
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    /**
     * Failed guesses against THIS code. At the configured ceiling the code is
     * burned — not the account locked, which would turn a guessing attempt into
     * a denial-of-service against the victim.
     */
    attempts: integer('attempts').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Covers both hot paths: finding the live token for a (user, purpose) pair,
     * and the resend-cooldown check, which reads the newest row for that pair.
     */
    index('auth_verification_tokens_user_purpose_idx').on(
      table.user_id,
      table.purpose,
      table.created_at,
    ),
  ],
);

export type VerificationTokenRow = typeof verificationTokensTable.$inferSelect;
export type NewVerificationTokenRow = typeof verificationTokensTable.$inferInsert;
export type VerificationPurpose = VerificationTokenRow['purpose'];
