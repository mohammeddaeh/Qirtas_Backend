import { pgTable, varchar, boolean, timestamp } from 'drizzle-orm/pg-core';

/**
 * Permission keys follow the mandatory `module.action` convention (module
 * name always plural — e.g. `orders.create`, `inventory.view`). The catalog
 * itself is intentionally left to grow module-by-module; this table just
 * enforces the shape. `key` is the primary key (no surrogate id needed —
 * it's a stable, human-assigned code, not user data).
 */
export const permissionsTable = pgTable('permissions', {
  key: varchar('key', { length: 100 }).primaryKey(),
  module: varchar('module', { length: 60 }).notNull(),
  is_sensitive: boolean('is_sensitive').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PermissionRow = typeof permissionsTable.$inferSelect;
export type NewPermissionRow = typeof permissionsTable.$inferInsert;
