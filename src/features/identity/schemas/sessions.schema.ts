import { pgTable, serial, integer, text, timestamp, index } from 'drizzle-orm/pg-core';
import { usersTable } from './users.schema.js';

/** Multiple concurrent sessions per user are allowed, no cap (users_roles.md). */
export const sessionsTable = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    device_info: text('device_info'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    last_active_at: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_user_idx').on(table.user_id)],
);

export type SessionRow = typeof sessionsTable.$inferSelect;
export type NewSessionRow = typeof sessionsTable.$inferInsert;
