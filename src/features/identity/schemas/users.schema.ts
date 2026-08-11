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
  /**
   * pending_verification: registered, but the email address is not yet proven.
   *
   * Added 2026-08-11, and it sits BEFORE `pending_approval` in the lifecycle
   * even though it is listed last here (enum order is storage order, not
   * process order — a new value can only be appended in PostgreSQL).
   *
   * ## Why it is a status and not only an `email_verified_at` column
   *
   * Both exist. The timestamp records the fact; the status records where the
   * account *is*. The distinction earns its keep at the review queue: admins
   * read `GET /users?status=pending_approval`, and an account that has not
   * proven its address must not appear there. With verification expressed only
   * as a nullable timestamp, either every queue query grows a second condition
   * — and the one that forgets it silently shows unverified registrations — or
   * the queue is floodable by anyone with a list of addresses they do not own.
   *
   * A verified account advances to `pending_approval` in the same write that
   * stamps `email_verified_at` (see AccountStore.markEmailVerified), so the two
   * cannot disagree.
   */
  'pending_verification',
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
  /**
   * ⚠️ RESERVED — the column exists, the feature does NOT.
   *
   * Nothing sets it, nothing reads it: no login path checks it, no endpoint
   * flips it, and no screen shows it. It is always `false`, and it travels to
   * the client only because the user DTO passes every column through.
   *
   * Deliberately kept rather than dropped (decision 2026-08-10) — MFA is
   * planned, just not now. It is annotated instead, because the danger of a
   * dormant security column is not the column: it is the next reader who sees
   * `mfa_enabled` in an API response and concludes the account is protected.
   *
   * **Before implementing**, decide the factor first (TOTP / SMS / email) —
   * they need different columns, and a boolean is unlikely to be one of them.
   * Tracked as E2 in docs/production_readiness.md.
   */
  mfa_enabled: boolean('mfa_enabled').notNull().default(false),
  /**
   * When this address was proven, or null if it has not been.
   *
   * A timestamp rather than a boolean: "when" answers questions "whether"
   * cannot — how long an account went unverified, whether verification predates
   * an incident, whether a re-verification after an email change ever happened.
   * Storing the fact costs the same either way.
   *
   * Paired with `status = 'pending_verification'`; see that value's note for
   * why both exist. The two are written together and never separately.
   */
  email_verified_at: timestamp('email_verified_at', { withTimezone: true }),

  // NOTE: `password_reset_token`/`password_reset_expires_at` were removed
  // 2026-08-11 and replaced by `auth_verification_tokens`. Two columns on this
  // row could hold exactly one token type and could not carry a per-code
  // attempt counter — so the reset code's only guessing limit was a per-IP rate
  // limiter, which an attacker rotating addresses never fills. See
  // core/auth/schemas/verification-tokens.schema.ts for the full reasoning.

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
