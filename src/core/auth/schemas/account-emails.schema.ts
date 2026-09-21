import {
  pgTable,
  serial,
  varchar,
  integer,
  timestamp,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';

export const accountRealmEnum = pgEnum('account_realm', ['staff', 'customer']);

/**
 * One row per email address held by ANY account, in ANY realm.
 *
 * ## Why this table exists
 *
 * Staff (`users`) and customers (`customers`) are separate tables, so each has
 * its own unique index on `email` — and neither can see the other. Checking
 * "is this address taken in the other table?" before inserting is a race: two
 * simultaneous sign-ups, one as staff and one as customer, both pass the check
 * and both insert. The unified sign-in would then face one address with two
 * accounts and no rule for choosing.
 *
 * A single unique index over both populations closes that. It is written in the
 * **same transaction** as the account row, so the two cannot disagree.
 *
 * ## What it deliberately is not
 *
 * Not an identity table. No password, no session, no profile — just the
 * uniqueness claim and a pointer back. `account_id` has no FK because it points
 * at one of two tables; the writers (`users.repository`, `customers.repository`)
 * are the only code that touches it, and both do so inside the account's own
 * transaction.
 *
 * Addresses are stored lower-cased: the DTOs already lower-case input, and the
 * unique index must not be defeated by `A@x.com` vs `a@x.com`.
 */
export const accountEmailsTable = pgTable(
  'account_emails',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    realm: accountRealmEnum('realm').notNull(),
    account_id: integer('account_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('account_emails_email_uidx').on(table.email),
    /** One address per account: lets `release`/`move` find the row by owner. */
    uniqueIndex('account_emails_owner_uidx').on(table.realm, table.account_id),
  ],
);
