import {
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { catalogUnitsTable } from '../../catalog/schemas/units.schema.js';
import { catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { pricingCurrencyEnum } from '../../catalog/schemas/catalog-enums.schema.js';
import { suppliersTable } from './suppliers.schema.js';

/**
 * A purchase invoice — the branch's own record of goods arriving
 * (inventory_suppliers.md §٧–§٨). Receiving happens through one of these, so
 * cost comes from its source rather than being typed into a stock screen and
 * lost.
 *
 * Posting is immediate and final: the movements exist the moment the invoice
 * is saved. A wrong invoice is corrected by a return to the supplier or an
 * adjustment, never by editing a document the ledger already points at.
 */
export const purchaseInvoicesTable = pgTable(
  'purchase_invoices',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    supplier_id: integer('supplier_id')
      .notNull()
      .references(() => suppliersTable.id, { onDelete: 'restrict' }),
    /** Ours: `GRN-<branch>-000012`, gapless per branch. */
    number: varchar('number', { length: 40 }).notNull(),
    /** Theirs, as written on the paper — searched when the supplier asks about it. */
    supplier_invoice_no: varchar('supplier_invoice_no', { length: 60 }),
    invoice_date: timestamp('invoice_date', { withTimezone: true }).notNull(),
    /** The currency the supplier billed in. */
    currency: pricingCurrencyEnum('currency').notNull(),
    /** The rate used to record cost in both currencies — frozen here, never re-derived. */
    exchange_rate: numeric('exchange_rate', { precision: 14, scale: 2 }),
    total_syp: numeric('total_syp', { precision: 14, scale: 2 }).notNull(),
    total_usd: numeric('total_usd', { precision: 14, scale: 4 }).notNull(),
    note: text('note'),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    numberUnique: uniqueIndex('purchase_invoices_number_unique').on(table.number),
    branchIdx: index('purchase_invoices_branch_idx').on(table.branch_id, table.created_at),
    supplierIdx: index('purchase_invoices_supplier_idx').on(table.supplier_id),
  }),
);

/**
 * One line, **as it was typed** (a carton of 12 at 60,000) *and* as stock
 * counts it (144 pieces at 500 each): both are kept, because the first is what
 * the reader can check against the paper and the second is what every report
 * adds up.
 */
export const purchaseInvoiceLinesTable = pgTable(
  'purchase_invoice_lines',
  {
    id: serial('id').primaryKey(),
    invoice_id: integer('invoice_id')
      .notNull()
      .references(() => purchaseInvoicesTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    unit_id: integer('unit_id')
      .notNull()
      .references(() => catalogUnitsTable.id, { onDelete: 'restrict' }),
    /** How many of [unit_id] arrived. */
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    /** Base units per one of that unit, as it was at the time. */
    factor: numeric('factor', { precision: 14, scale: 3 }).notNull(),
    qty_base: numeric('qty_base', { precision: 14, scale: 3 }).notNull(),
    /** Per [unit_id], in the invoice's currency. */
    unit_cost: numeric('unit_cost', { precision: 14, scale: 4 }).notNull(),
    unit_cost_base_syp: numeric('unit_cost_base_syp', { precision: 14, scale: 2 }).notNull(),
    unit_cost_base_usd: numeric('unit_cost_base_usd', { precision: 14, scale: 4 }).notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => ({
    invoiceIdx: index('purchase_invoice_lines_invoice_idx').on(table.invoice_id),
    variantIdx: index('purchase_invoice_lines_variant_idx').on(table.variant_id),
  }),
);

export type PurchaseInvoiceRow = typeof purchaseInvoicesTable.$inferSelect;
export type PurchaseInvoiceLineRow = typeof purchaseInvoiceLinesTable.$inferSelect;
