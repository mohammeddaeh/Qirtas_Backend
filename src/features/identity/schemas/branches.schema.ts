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
    /**
     * Retired from view without being destroyed — null means "in service".
     *
     * The second of the two ways a record leaves this system, and the one that
     * exists because the first cannot always apply. A branch nobody was ever
     * assigned to is deleted outright (`DELETE /branches/:id`): nothing points
     * at it, so nothing is lost. A branch that *was* staffed cannot be, because
     * `user_role_assignments.branch_id` is `RESTRICT` and those closed rows are
     * where "أحمد worked here in 2024" is written — deleting the branch would
     * erase a period of someone's employment record to tidy a list.
     *
     * So archiving answers the actual complaint ("I don't want to keep looking
     * at it") without paying for it in history: the row survives, every
     * assignment that points at it still resolves to a real branch with a real
     * name, and the branch disappears from every list, picker and filter that
     * does not explicitly ask for archived rows. It is reversible.
     */
    archived_at: timestamp('archived_at', { withTimezone: true }),
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
