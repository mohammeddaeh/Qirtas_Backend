import { index, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { purchaseInvoicesTable } from './receipts.schema.js';
import { suppliersTable } from './suppliers.schema.js';

/**
 * Goods going back to the supplier — inventory_suppliers.md §٧.
 *
 * Its own document rather than an adjustment, because the two answer
 * different questions: an adjustment says stock vanished on our side, a
 * return says the supplier took it back — and only the second belongs in what
 * we owe him.
 *
 * Valued at **the cost it came in at**, read from the invoice being returned
 * against: the moving average may have moved since, and a supplier is credited
 * for what he charged, not for what our shelf averages to today.
 */
export const purchaseReturnsTable = pgTable(
  'purchase_returns',
  {
    id: serial('id').primaryKey(),
    number: varchar('number', { length: 40 }).notNull(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    supplier_id: integer('supplier_id')
      .notNull()
      .references(() => suppliersTable.id, { onDelete: 'restrict' }),
    /** The invoice the goods arrived on — where their cost is read from. */
    receipt_id: integer('receipt_id')
      .notNull()
      .references(() => purchaseInvoicesTable.id, { onDelete: 'restrict' }),
    /** Required: "why did it go back" is the fact a supplier will ask about. */
    note: text('note').notNull(),
    total_syp: numeric('total_syp', { precision: 14, scale: 2 }).notNull(),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    numberUnique: uniqueIndex('purchase_returns_number_unique').on(table.number),
    branchIdx: index('purchase_returns_branch_idx').on(table.branch_id, table.created_at),
    receiptIdx: index('purchase_returns_receipt_idx').on(table.receipt_id),
  }),
);

export const purchaseReturnLinesTable = pgTable(
  'purchase_return_lines',
  {
    id: serial('id').primaryKey(),
    return_id: integer('return_id')
      .notNull()
      .references(() => purchaseReturnsTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    /** In base units, positive: how much goes back. The movement it posts is negative. */
    qty_base: numeric('qty_base', { precision: 14, scale: 3 }).notNull(),
    unit_cost_syp: numeric('unit_cost_syp', { precision: 14, scale: 2 }).notNull(),
    unit_cost_usd: numeric('unit_cost_usd', { precision: 14, scale: 4 }).notNull(),
  },
  (table) => ({
    returnIdx: index('purchase_return_lines_return_idx').on(table.return_id),
  }),
);

export type PurchaseReturnRow = typeof purchaseReturnsTable.$inferSelect;
