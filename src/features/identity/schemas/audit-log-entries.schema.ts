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
    /**
     * The actor — nullable as of 2026-08-11.
     *
     * It was `NOT NULL`, which was correct while every audited action was
     * performed by a signed-in admin. It stopped being correct the moment
     * authentication events joined the log: a failed sign-in against an
     * address that does not exist has **no actor**, and that is precisely the
     * event a brute-force attempt produces. The single most alert-worthy row
     * this table can hold was the one row the schema refused to store.
     *
     * Null therefore means "no authenticated actor", not "unknown" — every
     * business mutation still writes one, and the reader can tell the two
     * situations apart by the action name.
     */
    user_id: integer('user_id').references(() => usersTable.id, { onDelete: 'restrict' }),
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
