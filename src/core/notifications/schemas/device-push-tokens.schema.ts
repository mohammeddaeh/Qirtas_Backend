import { pgTable, serial, integer, varchar, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { accountRealmEnum } from '../../auth/schemas/account-emails.schema.js';

/**
 * One row per **device** that can receive a push (an FCM registration token).
 *
 * ## Why the token, not (account, token), is unique
 *
 * A token identifies a physical install. When a second person signs in on the
 * same phone, the token is unchanged — it must **move** to them, or the previous
 * user keeps receiving the new user's notifications (a customer's wholesale
 * decision arriving on an employee's shared phone). Registration is therefore an
 * upsert on `token` that rewrites the owner.
 *
 * No FK to the account: it points at one of two tables (like `account_emails`).
 * Rows are removed at sign-out and when FCM reports the token dead.
 */
export const devicePushTokensTable = pgTable(
  'device_push_tokens',
  {
    id: serial('id').primaryKey(),
    realm: accountRealmEnum('realm').notNull(),
    account_id: integer('account_id').notNull(),
    token: varchar('token', { length: 512 }).notNull(),
    platform: varchar('platform', { length: 16 }).notNull(),
    /** The app language on that device — the push is written in it. */
    language: varchar('language', { length: 8 }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('device_push_tokens_token_uq').on(t.token),
    index('device_push_tokens_account_idx').on(t.realm, t.account_id),
  ],
);

export type DevicePushTokenRow = typeof devicePushTokensTable.$inferSelect;
