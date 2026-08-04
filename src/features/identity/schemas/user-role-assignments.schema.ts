import { sql } from 'drizzle-orm';
import { pgTable, serial, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { usersTable } from './users.schema.js';
import { rolesTable } from './roles.schema.js';
import { branchesTable } from './branches.schema.js';

/**
 * branch_id null = unrestricted (all branches). valid_to null = no expiry.
 * "Active" assignment = valid_to IS NULL OR valid_to > now() (checked in the
 * repository/service layer, not as a DB constraint).
 *
 * Branch transfers/offboarding never mutate branch_id in place — they close
 * the current row (valid_to = transfer date) and open a new one, preserving
 * history (see users_roles.md — User & Role Assignment Lifecycle).
 */
export const userRoleAssignmentsTable = pgTable(
  'user_role_assignments',
  {
    id: serial('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    role_id: integer('role_id')
      .notNull()
      .references(() => rolesTable.id, { onDelete: 'restrict' }),
    branch_id: integer('branch_id').references(() => branchesTable.id, { onDelete: 'restrict' }),
    valid_from: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    valid_to: timestamp('valid_to', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('user_role_assignments_user_branch_role_idx').on(
      table.user_id,
      table.branch_id,
      table.role_id,
    ),
    index('user_role_assignments_role_idx').on(table.role_id),
    // One person cannot hold the same role in the same branch twice AT ONCE.
    //
    // Partial (`WHERE valid_to IS NULL`) because history must still allow the
    // repeat: someone may leave a post and return to it later, which is two
    // rows with the same triple where only the newer one is open. Without the
    // predicate this index would forbid that legitimate history.
    //
    // `COALESCE(branch_id, -1)` rather than the bare column: in a unique index
    // Postgres treats every NULL as distinct, so two *unrestricted* (all
    // -branches) assignments of the same role to the same person would not
    // collide — the exact duplicate this index exists to stop. -1 is safe as a
    // sentinel because branch ids are positive serials.
    //
    // Known gap: a row with a future `valid_to` (a scheduled end) still counts
    // as active in the service layer but falls outside this predicate.
    // Accepted — a partial-index predicate must be immutable, so `now()`
    // cannot appear in it (production_readiness.md §B3).
    uniqueIndex('user_role_assignments_active_unique_idx')
      .on(table.user_id, table.role_id, sql`COALESCE(${table.branch_id}, -1)`)
      .where(sql`${table.valid_to} IS NULL`),
  ],
);

export type UserRoleAssignmentRow = typeof userRoleAssignmentsTable.$inferSelect;
export type NewUserRoleAssignmentRow = typeof userRoleAssignmentsTable.$inferInsert;
