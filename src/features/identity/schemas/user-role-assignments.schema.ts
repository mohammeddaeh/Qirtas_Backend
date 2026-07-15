import { pgTable, serial, integer, timestamp, index } from 'drizzle-orm/pg-core';
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
  ],
);

export type UserRoleAssignmentRow = typeof userRoleAssignmentsTable.$inferSelect;
export type NewUserRoleAssignmentRow = typeof userRoleAssignmentsTable.$inferInsert;
