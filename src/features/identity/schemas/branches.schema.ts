import {
  pgTable,
  serial,
  varchar,
  text,
  boolean,
  timestamp,
  pgEnum,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Branch status. `temporarilyClosed` keeps assignments untouched (they resume
 * automatically on reactivation); `closed` is the terminal state reached only
 * after the User & Role Assignment Lifecycle flow clears every assignment and
 * every in-progress task for the branch (see docs/reference/users_roles.md).
 */
export const branchStatusEnum = pgEnum('branch_status', ['active', 'temporarily_closed', 'closed']);

export const branchesTable = pgTable(
  'branches',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 150 }).notNull(),
    address: text('address'),
    contact_info: text('contact_info'),
    status: branchStatusEnum('status').notNull().default('active'),
    /**
     * When `status` last changed — set by the service on every status
     * transition, never by a request body.
     *
     * Exists so "temporarily closed" can be held to its own word: without a
     * timestamp there is no way to notice a pause that has quietly become
     * permanent (production_readiness.md §C2). Existing rows adopt the
     * migration time rather than their creation time, so nothing appears to
     * have been closed for years the moment this column ships.
     */
    status_changed_at: timestamp('status_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    is_default: boolean('is_default').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Unique like `roles.name` — the asymmetry was an oversight, not a decision
  // (production_readiness.md §B1). Two branches sharing a name are
  // indistinguishable in every picker, staff row and report, and the mistake
  // only surfaces after people have been assigned to the wrong one.
  (table) => [uniqueIndex('branches_name_unique_idx').on(table.name)],
);

export type BranchRow = typeof branchesTable.$inferSelect;
export type NewBranchRow = typeof branchesTable.$inferInsert;
