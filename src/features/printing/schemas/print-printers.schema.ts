import { boolean, integer, pgTable, serial, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';

/**
 * A branch's printers (9-ط-2, `printing_system.md`) — where a job is printed,
 * so «للتنفيذ» splits by printer and the card says where to collect the copies.
 *
 * **Colour is the one capability today**: a colour job on a black-and-white
 * printer is a mistake the server refuses. Paper sizes join when a branch asks.
 * A printer that printed a job is deactivated, not deleted — its name stays on
 * orders that went through it.
 */
export const printPrintersTable = pgTable(
  'print_printers',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 80 }).notNull(),
    supports_color: boolean('supports_color').notNull().default(true),
    is_active: boolean('is_active').notNull().default(true),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Two «Epson» at one branch are one printer to whoever reads the card. */
    nameOnce: uniqueIndex('print_printers_name_once').on(table.branch_id, table.name),
  }),
);

export type PrintPrinterRow = typeof printPrintersTable.$inferSelect;
export type NewPrintPrinterRow = typeof printPrintersTable.$inferInsert;
