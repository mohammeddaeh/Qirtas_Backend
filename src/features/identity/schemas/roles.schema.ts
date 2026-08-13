import {
  pgTable,
  serial,
  varchar,
  integer,
  boolean,
  timestamp,
  pgEnum,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * category groups roles for UI/reporting only — it does NOT drive any
 * "last qualified staff" special-casing (that rule applies uniformly to every
 * role, see docs/reference/users_roles.md §"آخر موظف مؤهل").
 */
export const roleCategoryEnum = pgEnum('role_category', [
  'system',
  'management',
  'operational',
  'financial',
  'external',
]);

/**
 * Authority hierarchy: lower level = higher authority (Super Admin = 0).
 * `level` is immutable after creation via the normal role-edit screen — the
 * only allowed edit path for an existing role's level requires Super Admin
 * exclusively (see users_roles.md, "سد ثغرة" note). That exception is
 * enforced in the service layer, not the schema.
 */
export const rolesTable = pgTable(
  'roles',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    category: roleCategoryEnum('category').notNull(),
    level: integer('level'),
    is_system_default: boolean('is_system_default').notNull().default(false),
    is_active: boolean('is_active').notNull().default(true),
    /**
     * Retired from view without being destroyed — null means "in the catalogue".
     *
     * Distinct from `is_active`, which every existing screen already treats as
     * reversible and expects to browse: a deactivated role still appears in the
     * roles list under the "معطَّل" filter because bringing it back is a normal
     * thing to do. Archiving says the opposite — this one is finished, stop
     * showing it to me — and so it drops out of the list entirely unless the
     * caller asks for archived rows by name.
     *
     * It exists because deletion cannot cover the case: `deleteRole` refuses
     * any role that has ever been assigned (`role_has_history`), since
     * `user_role_assignments.role_id` is `RESTRICT` and those closed rows are
     * what "أحمد was a cashier until March" is made of. A role that has been
     * held and is held by nobody now had no exit at all before this column.
     */
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('roles_name_unique_idx').on(table.name)],
);

export type RoleRow = typeof rolesTable.$inferSelect;
export type NewRoleRow = typeof rolesTable.$inferInsert;
