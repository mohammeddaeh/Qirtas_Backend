import {
  pgTable,
  integer,
  text,
  timestamp,
  serial,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { accountRealmEnum } from './account-emails.schema.js';

/**
 * A second factor (TOTP) per account, in any realm.
 *
 * No FK to the account: like `account_emails`, the row points at one of two
 * tables. The writers clear it when an account's credentials are reset.
 *
 * `confirmed_at IS NULL` = enrollment started but the person never proved their
 * phone produces matching codes. Such a row protects nothing and is replaced by
 * the next `setup`; only a confirmed row challenges sign-in.
 */
export const accountMfaTable = pgTable(
  'account_mfa',
  {
    realm: accountRealmEnum('realm').notNull(),
    account_id: integer('account_id').notNull(),
    /** AES-GCM sealed secret — see `mfa/secret-box.ts`. */
    secret_sealed: text('secret_sealed').notNull(),
    confirmed_at: timestamp('confirmed_at', { withTimezone: true }),
    /** Highest time step already accepted — a code cannot be used twice. */
    last_used_step: integer('last_used_step'),
    failed_attempts: integer('failed_attempts').notNull().default(0),
    locked_until: timestamp('locked_until', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.realm, t.account_id] })],
);

/** One-time fallbacks for a lost phone. Hashed: they are credentials. */
export const accountMfaRecoveryCodesTable = pgTable(
  'account_mfa_recovery_codes',
  {
    id: serial('id').primaryKey(),
    realm: accountRealmEnum('realm').notNull(),
    account_id: integer('account_id').notNull(),
    code_hash: text('code_hash').notNull(),
    used_at: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('account_mfa_recovery_lookup_idx').on(t.realm, t.account_id)],
);

export type AccountMfaRow = typeof accountMfaTable.$inferSelect;
