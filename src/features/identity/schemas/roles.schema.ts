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
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('roles_name_unique_idx').on(table.name)],
);

export type RoleRow = typeof rolesTable.$inferSelect;
export type NewRoleRow = typeof rolesTable.$inferInsert;
