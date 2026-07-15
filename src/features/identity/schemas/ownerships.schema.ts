import { pgTable, serial, integer, numeric, timestamp } from 'drizzle-orm/pg-core';
import { usersTable } from './users.schema.js';
import { branchesTable } from './branches.schema.js';

/**
 * Documentary/reporting record only — NOT the access-control source of truth
 * (that's UserRoleAssignment.branch_id, exclusively). branch_scope null =
 * "all branches". The sum of active percentages (valid_to IS NULL or in the
 * future) per branch_scope must never exceed 100 — enforced in the service
 * layer at write time (see users_roles.md — Ownership & Financial Partner
 * Reporting, decision 2026-07-09).
 */
export const ownershipsTable = pgTable('ownerships', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id')
    .notNull()
    .references(() => usersTable.id, { onDelete: 'cascade' }),
  percentage: numeric('percentage', { precision: 5, scale: 2 }).notNull(),
  branch_scope: integer('branch_scope').references(() => branchesTable.id, {
    onDelete: 'restrict',
  }),
  valid_from: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  valid_to: timestamp('valid_to', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OwnershipRow = typeof ownershipsTable.$inferSelect;
export type NewOwnershipRow = typeof ownershipsTable.$inferInsert;
