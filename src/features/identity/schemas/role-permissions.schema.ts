import { pgTable, serial, integer, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { rolesTable } from './roles.schema.js';
import { permissionsTable } from './permissions.schema.js';

export const rolePermissionsTable = pgTable(
  'role_permissions',
  {
    id: serial('id').primaryKey(),
    role_id: integer('role_id')
      .notNull()
      .references(() => rolesTable.id, { onDelete: 'cascade' }),
    permission_key: varchar('permission_key', { length: 100 })
      .notNull()
      .references(() => permissionsTable.key, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('role_permissions_role_permission_unique_idx').on(
      table.role_id,
      table.permission_key,
    ),
  ],
);

export type RolePermissionRow = typeof rolePermissionsTable.$inferSelect;
export type NewRolePermissionRow = typeof rolePermissionsTable.$inferInsert;
