import {
  pgTable,
  serial,
  varchar,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  pgEnum,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { rolesTable } from './roles.schema.js';
import { branchesTable } from './branches.schema.js';

/**
 * pending_approval: created via self-registration, no active UserRoleAssignment yet.
 * active: normal working account.
 * suspended: temporary, reversible (investigation, long leave) — access revoked
 *   like `disabled`, but carries an explicit expectation of return.
 * rejected: admin declined the registration request; account stays reachable
 *   so the person can see the reason and submit a new request.
 * disabled: permanent/manual offboarding — access revoked, historical records
 *   stay attributed to this user forever. Hard delete is only ever allowed for
 *   a user with zero historical activity.
 * See docs/reference/users_roles.md and users_complete_reference.md.
 */
export const userStatusEnum = pgEnum('user_status', [
  'pending_approval',
  'active',
  'suspended',
  'rejected',
  'disabled',
]);

export const usersTable = pgTable('users', {
  id: serial('id').primaryKey(),
  first_name: varchar('first_name', { length: 100 }).notNull(),
  last_name: varchar('last_name', { length: 100 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  phone: varchar('phone', { length: 32 }).notNull(),
  image: text('image'),
  address: text('address'),
  // NOTE: `is_active` was removed 2026-08-04. It was a second source of truth
  // for something `status` already answers, read by exactly zero pieces of
  // logic while still being sent to clients — an invitation to write
  // `if (user.is_active)` and get `true` for a disabled account
  // (production_readiness.md §B2). Account state lives in `status` alone.
  is_admin: boolean('is_admin').notNull().default(false),

  // --- Root Protected Account (docs/reference/users_roles.md — Feature:
  // Root Protected Account, 2026-07-27). Set to true ONLY inside
  // bootstrapSuperAdmin() at first-run — never accepted as request input on
  // any endpoint (absent from createUserByAdminBodySchema/updateUserBodySchema
  // and every other user-input zod schema). Exactly one row in the whole
  // system may ever carry true. ---
  is_root_protected: boolean('is_root_protected').notNull().default(false),

  // --- Authentication (users_roles.md — Feature: Authentication) ---
  password_hash: varchar('password_hash', { length: 255 }).notNull(),
  mfa_enabled: boolean('mfa_enabled').notNull().default(false),
  password_reset_token: varchar('password_reset_token', { length: 255 }),
  password_reset_expires_at: timestamp('password_reset_expires_at', { withTimezone: true }),

  // --- Self-registration & approval lifecycle ---
  status: userStatusEnum('status').notNull().default('pending_approval'),
  rejection_reason: text('rejection_reason'),
  requested_role_id: integer('requested_role_id').references(() => rolesTable.id, {
    onDelete: 'set null',
  }),
  requested_branch_id: integer('requested_branch_id').references(() => branchesTable.id, {
    onDelete: 'set null',
  }),
  requested_ownership_percentage: numeric('requested_ownership_percentage', {
    precision: 5,
    scale: 2,
  }),
  submitted_at: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  decided_at: timestamp('decided_at', { withTimezone: true }),
  decided_by_user_id: integer('decided_by_user_id').references((): AnyPgColumn => usersTable.id, {
    onDelete: 'set null',
  }),

  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof usersTable.$inferSelect;
export type NewUserRow = typeof usersTable.$inferInsert;
