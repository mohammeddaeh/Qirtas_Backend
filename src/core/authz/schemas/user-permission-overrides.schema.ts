import { index, integer, pgEnum, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core';
import { accountsTable } from '../../auth/schemas/account-table.js';

/**
 * Per-account exceptions to what the roles say.
 *
 * ## Why this exists
 *
 * Roles answer "what does this job do". They cannot answer "…except Ahmad, who
 * must not delete". Without a way to say that, every exception becomes a role
 * with one member — and a deployment ends up with forty roles nobody can
 * describe, each differing from another by a single checkbox.
 *
 * ## Deliberately **not** scoped to a branch
 *
 * `user_role_assignments` carries `branch_id`, and this table could have too.
 * It does not, by decision: an override says something about **the person**
 * ("Ahmad may not delete"), not about a post they hold in one place. Scoping it
 * would raise a question with no good answer — does a branch-less override beat
 * a branch-scoped one, or the reverse? — and every reading of the resolver
 * would have to carry it.
 *
 * The simple rule is the one an administrator can hold in their head:
 * **an override applies to the account, everywhere.** If a project later needs
 * per-branch exceptions, that is a new column and a stated precedence rule,
 * added when a real case demands it rather than guessed at now.
 *
 * ## The tri-state
 *
 * *inherit / allow / deny* — and **inherit is the absence of a row**, not a
 * value. Storing it would create two ways to say the same thing and a migration
 * the first time they disagreed.
 */
export const overrideEffectEnum = pgEnum('authz_override_effect', ['allow', 'deny']);

export const userPermissionOverridesTable = pgTable(
  'authz_user_permission_overrides',
  {
    user_id: integer('user_id')
      .notNull()
      .references(() => accountsTable.id, { onDelete: 'cascade' }),

    /**
     * Free text, not a foreign key to `permissions`.
     *
     * The catalogue row is created and destroyed by the seed as routes come and
     * go (see `seed-core.ts`); a foreign key would make an override block that,
     * or vanish with it. An override for a key no route enforces is simply
     * inert — the resolver ignores it — and the roles screen can show it as
     * stale rather than have it disappear silently.
     */
    permission_key: varchar('permission_key', { length: 100 }).notNull(),

    effect: overrideEffectEnum('effect').notNull(),

    /** Why the exception exists. An override with no stated reason outlives everyone who remembers it. */
    note: varchar('note', { length: 300 }),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per (user, key): an account cannot be both allowed and denied the
    // same permission, so the contradiction is unrepresentable rather than
    // resolved by a precedence rule nobody would find.
    primaryKey({ columns: [table.user_id, table.permission_key] }),
    // Every authenticated request resolves overrides for one user — this index
    // is on the hot path, not on a report.
    index('authz_overrides_user_idx').on(table.user_id),
  ],
);

export type UserPermissionOverrideRow = typeof userPermissionOverridesTable.$inferSelect;
export type NewUserPermissionOverrideRow = typeof userPermissionOverridesTable.$inferInsert;
