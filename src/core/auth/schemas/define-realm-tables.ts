import { pgTable, serial, integer, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { verificationPurposeEnum } from './verification-tokens.schema.js';
import type { sessionsTable } from './sessions.schema.js';
import type { verificationTokensTable } from './verification-tokens.schema.js';

/**
 * Builds a second realm's credential tables, structurally identical to the
 * staff ones in `sessions.schema.ts` / `verification-tokens.schema.ts`.
 *
 * The reasoning for every column lives in those two files and is not repeated;
 * what matters here is that the *foreign key targets the realm's own accounts
 * table*, so deleting a customer cascades to that customer's sessions and codes
 * — and a staff token can never be found in these rows, nor the reverse.
 *
 * `sessions`/`tokens` are typed as the staff tables (the shapes are identical,
 * so the repositories can take one type; the cast is confined to this file).
 * At runtime they are the real tables, so drizzle-kit sees them as such.
 */
export function defineRealmTables(prefix: string, accounts: { id: AnyPgColumn }) {
  const sessions = pgTable(
    `${prefix}_sessions`,
    {
      id: serial('id').primaryKey(),
      user_id: integer('user_id')
        .notNull()
        .references(() => accounts.id, { onDelete: 'cascade' }),
      token_hash: varchar('token_hash', { length: 64 }).notNull().unique(),
      provider: varchar('provider', { length: 32 }).notNull().default('local'),
      device_info: text('device_info'),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      last_active_at: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
      last_rotated_at: timestamp('last_rotated_at', { withTimezone: true }).notNull().defaultNow(),
      expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      index(`${prefix}_sessions_user_idx`).on(t.user_id),
      index(`${prefix}_sessions_expires_idx`).on(t.expires_at),
    ],
  );

  const tokens = pgTable(
    `${prefix}_verification_tokens`,
    {
      id: serial('id').primaryKey(),
      user_id: integer('user_id')
        .notNull()
        .references(() => accounts.id, { onDelete: 'cascade' }),
      purpose: verificationPurposeEnum('purpose').notNull(),
      token_hash: varchar('token_hash', { length: 64 }).notNull(),
      expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
      consumed_at: timestamp('consumed_at', { withTimezone: true }),
      attempts: integer('attempts').notNull().default(0),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      index(`${prefix}_verification_tokens_user_purpose_idx`).on(
        t.user_id,
        t.purpose,
        t.created_at,
      ),
    ],
  );

  return {
    sessions: sessions as unknown as typeof sessionsTable,
    tokens: tokens as unknown as typeof verificationTokensTable,
  };
}
