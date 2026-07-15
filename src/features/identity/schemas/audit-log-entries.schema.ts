import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { usersTable } from './users.schema.js';
import { branchesTable } from './branches.schema.js';

/**
 * Mandatory for any action on a Permission.isSensitive=true (e.g. editing an
 * existing role's permissions, deleting critical data, full financial
 * access). previous_value/new_value hold the actual before/after diff, not
 * just "was edited". Enriched with ip_address/device_info/performed_by_role/
 * branch_context per the 2026-07-09 decision (see users_roles.md).
 */
export const auditLogEntriesTable = pgTable(
  'audit_log_entries',
  {
    id: serial('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    action: varchar('action', { length: 150 }).notNull(),
    target_entity: varchar('target_entity', { length: 150 }).notNull(),
    previous_value: jsonb('previous_value'),
    new_value: jsonb('new_value'),
    ip_address: varchar('ip_address', { length: 45 }),
    device_info: text('device_info'),
    performed_by_role: varchar('performed_by_role', { length: 100 }),
    branch_context: integer('branch_context').references(() => branchesTable.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_entries_user_created_idx').on(table.user_id, table.created_at),
    index('audit_log_entries_target_created_idx').on(table.target_entity, table.created_at),
  ],
);

export type AuditLogEntryRow = typeof auditLogEntriesTable.$inferSelect;
export type NewAuditLogEntryRow = typeof auditLogEntriesTable.$inferInsert;
