import { pgTable, serial, varchar, text, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';

/**
 * Branch status. `temporarilyClosed` keeps assignments untouched (they resume
 * automatically on reactivation); `closed` is the terminal state reached only
 * after the User & Role Assignment Lifecycle flow clears every assignment and
 * every in-progress task for the branch (see docs/reference/users_roles.md).
 */
export const branchStatusEnum = pgEnum('branch_status', ['active', 'temporarily_closed', 'closed']);

export const branchesTable = pgTable('branches', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 150 }).notNull(),
  address: text('address'),
  contact_info: text('contact_info'),
  status: branchStatusEnum('status').notNull().default('active'),
  is_default: boolean('is_default').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BranchRow = typeof branchesTable.$inferSelect;
export type NewBranchRow = typeof branchesTable.$inferInsert;
