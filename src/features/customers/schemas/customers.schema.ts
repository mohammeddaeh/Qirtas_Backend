import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { defineRealmTables } from '../../../core/auth/schemas/define-realm-tables.js';

/**
 * Three states, not the staff six (docs/reference/customer_accounts.md §4).
 *
 * A customer is `active` the moment they register — there is no reviewer for a
 * "pending" state to wait on. Whether their **email is proven** is a separate
 * fact (`email_verified_at`) that gates *purchasing*, not signing in.
 */
export const customerStatusEnum = pgEnum('customer_status', ['active', 'suspended', 'disabled']);

export const customerTypeEnum = pgEnum('customer_type', ['retail', 'wholesale']);

/** Independent of `status`: a person awaiting a wholesale upgrade can still buy at retail meanwhile. */
export const wholesaleStatusEnum = pgEnum('wholesale_status', ['pending', 'approved', 'rejected']);

export const customersTable = pgTable(
  'customers',
  {
    id: serial('id').primaryKey(),
    first_name: varchar('first_name', { length: 100 }).notNull(),
    last_name: varchar('last_name', { length: 100 }).notNull(),
    /** Required for now: sign-in and verification are email-only until an SMS port exists (OTP deferred). */
    email: varchar('email', { length: 255 }).notNull().unique(),
    /** Stored, not yet a login or verification factor. */
    phone: varchar('phone', { length: 32 }),
    password_hash: varchar('password_hash', { length: 255 }).notNull(),
    email_verified_at: timestamp('email_verified_at', { withTimezone: true }),
    phone_verified_at: timestamp('phone_verified_at', { withTimezone: true }),
    status: customerStatusEnum('status').notNull().default('active'),
    customer_type: customerTypeEnum('customer_type').notNull().default('retail'),
    wholesale_status: wholesaleStatusEnum('wholesale_status'),
    /** When the CURRENT request was filed — reset on a resubmission after a rejection. */
    wholesale_requested_at: timestamp('wholesale_requested_at', { withTimezone: true }),
    wholesale_decided_at: timestamp('wholesale_decided_at', { withTimezone: true }),
    /** The employee who decided. `set null`: a departed employee must not erase the decision. */
    wholesale_decided_by_user_id: integer('wholesale_decided_by_user_id').references(
      () => usersTable.id,
      { onDelete: 'set null' },
    ),
    /** Shown to the customer so a rejection is an answer, not a silence. */
    wholesale_rejection_reason: text('wholesale_rejection_reason'),
    /** A display preference — no RBAC meaning, no approval, no history (§5). */
    preferred_branch_id: integer('preferred_branch_id').references(() => branchesTable.id, {
      onDelete: 'set null',
    }),
    image: text('image'),
    address: text('address'),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // `approved` IS the wholesale type — the two cannot disagree; a retail
    // customer may be waiting (`pending`) or turned down (`rejected`), and one
    // who never asked has no status at all.
    check(
      'customers_wholesale_status_chk',
      sql`(${t.wholesale_status} IS NULL AND ${t.customer_type} = 'retail') OR (${t.wholesale_status} = 'approved' AND ${t.customer_type} = 'wholesale') OR (${t.wholesale_status} IN ('pending', 'rejected') AND ${t.customer_type} = 'retail')`,
    ),
  ],
);

export type CustomerRow = typeof customersTable.$inferSelect;
export type NewCustomerRow = typeof customersTable.$inferInsert;

const realmTables = defineRealmTables('customer', customersTable);

/** Typed as the staff tables — see `defineRealmTables`. Same objects drizzle-kit sees. */
export const customerSessionsTable = realmTables.sessions;
export const customerVerificationTokensTable = realmTables.tokens;

/**
 * What a customer did — sign-ins, failures, verification, password changes.
 *
 * Separate from `audit_log_entries` because that table's `user_id` is an FK to
 * `users` with `RESTRICT`: a customer id written there would violate it or,
 * worse, point at an unrelated employee.
 */
export const customerActivityLogTable = pgTable('customer_activity_log', {
  id: serial('id').primaryKey(),
  /** Null for events with no known account — a failed sign-in against an unregistered address. */
  customer_id: integer('customer_id').references(() => customersTable.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 64 }).notNull(),
  /** The address attempted, when no account is known. */
  email: varchar('email', { length: 255 }),
  details: text('details'),
  ip_address: varchar('ip_address', { length: 64 }),
  device_info: text('device_info'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
