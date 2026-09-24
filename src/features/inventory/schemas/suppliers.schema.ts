import { boolean, index, integer, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { usersTable } from '../../identity/schemas/users.schema.js';

/**
 * A supplier is **shared across branches** (inventory_suppliers.md §٧): the
 * same trader delivers to several branches, and a per-branch copy would make
 * "what do we owe him" a question no report could answer.
 *
 * What each branch owns is its own purchase invoices, not the supplier record.
 */
export const suppliersTable = pgTable(
  'suppliers',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 150 }).notNull(),
    /** Folded Arabic, for search and for refusing a near-duplicate name. */
    search_text: text('search_text').notNull(),
    phone: varchar('phone', { length: 30 }),
    email: varchar('email', { length: 150 }),
    address: text('address'),
    notes: text('notes'),
    is_active: boolean('is_active').notNull().default(true),
    /** Archived: gone from every picker, still named on old invoices. */
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    searchIdx: index('suppliers_search_idx').on(table.search_text),
  }),
);

export type SupplierRow = typeof suppliersTable.$inferSelect;
export type NewSupplierRow = typeof suppliersTable.$inferInsert;
