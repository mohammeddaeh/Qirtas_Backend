import { index, integer, numeric, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { purchaseInvoicesTable } from '../../inventory/schemas/receipts.schema.js';
import { suppliersTable } from '../../inventory/schemas/suppliers.schema.js';

/**
 * What the shop owes its suppliers — `docs/reference/finance_operations.md` §٣/§٣-ب.
 *
 * **A debt stays in its invoice's currency**: a dollar invoice is a dollar debt,
 * and the liras it costs to settle are known only on the day it is paid. The
 * difference between the invoice's rate and the payment's is a **realized**
 * exchange gain or loss, booked with the payment; an open dollar debt's value
 * at today's rate is shown, never booked.
 *
 * Nothing is edited: a wrong payment is undone by its opposite (`reverses_payment_id`),
 * and its allocations with it.
 */
export const supplierPaymentsTable = pgTable(
  'supplier_payments',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    supplier_id: integer('supplier_id')
      .notNull()
      .references(() => suppliersTable.id, { onDelete: 'restrict' }),
    /** `SYP` · `USD` — what left the shop. */
    currency: varchar('currency', { length: 3 }).notNull(),
    /** In [currency]; a reversal is negative. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /**
     * The rate the payment was valued at: for dollars, the buy rate then (what our
     * dollars were worth); for liras paying a dollar debt, the rate agreed with the supplier.
     */
    fx_rate: numeric('fx_rate', { precision: 14, scale: 4 }).notNull(),
    /** `drawer` (through the branch's open shift) · `outside` (the owner, a bank). */
    source: varchar('source', { length: 10 }).notNull(),
    shift_id: integer('shift_id'),
    movement_id: integer('movement_id'),
    note: text('note'),
    reverses_payment_id: integer('reverses_payment_id'),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    supplierIdx: index('supplier_payments_supplier_idx').on(table.supplier_id, table.created_at),
    branchIdx: index('supplier_payments_branch_idx').on(table.branch_id, table.created_at),
  }),
);

/**
 * A dollar debt fixed in liras («ثبّتنا الدين بالليرة على ١٣٬٢٠٠») — the dollars
 * leave the invoice and a lira debt opens on it, and the difference from the
 * invoice's rate is realized at the conversion.
 */
export const supplierConversionsTable = pgTable(
  'supplier_conversions',
  {
    id: serial('id').primaryKey(),
    invoice_id: integer('invoice_id')
      .notNull()
      .references(() => purchaseInvoicesTable.id, { onDelete: 'restrict' }),
    amount_usd: numeric('amount_usd', { precision: 14, scale: 4 }).notNull(),
    rate: numeric('rate', { precision: 14, scale: 4 }).notNull(),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    /** Signed: positive = the shop gained (the agreed rate below the invoice's). */
    fx_gain_syp: numeric('fx_gain_syp', { precision: 14, scale: 2 }).notNull(),
    note: text('note'),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    invoiceIdx: index('supplier_conversions_invoice_idx').on(table.invoice_id),
  }),
);

/**
 * How a payment settled invoices — the oldest first unless the payer chose.
 * [bucket] is the debt it lowered: `USD` (a dollar invoice) or `SYP` (a lira
 * invoice, or a dollar one fixed in liras). `invoice_id` null = left with the
 * supplier as our credit (only when the shop allows it).
 */
export const supplierAllocationsTable = pgTable(
  'supplier_allocations',
  {
    id: serial('id').primaryKey(),
    payment_id: integer('payment_id')
      .notNull()
      .references(() => supplierPaymentsTable.id, { onDelete: 'restrict' }),
    invoice_id: integer('invoice_id').references(() => purchaseInvoicesTable.id, { onDelete: 'restrict' }),
    bucket: varchar('bucket', { length: 3 }).notNull(),
    /** In [bucket]; negative on a reversal. */
    amount: numeric('amount', { precision: 14, scale: 4 }).notNull(),
    /** Realized on this slice — (invoice rate − payment rate) × dollars. Signed. */
    fx_gain_syp: numeric('fx_gain_syp', { precision: 14, scale: 2 }).notNull().default('0'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    paymentIdx: index('supplier_allocations_payment_idx').on(table.payment_id),
    invoiceIdx: index('supplier_allocations_invoice_idx').on(table.invoice_id),
  }),
);

export type SupplierPaymentRow = typeof supplierPaymentsTable.$inferSelect;
export type SupplierAllocationRow = typeof supplierAllocationsTable.$inferSelect;
export type SupplierConversionRow = typeof supplierConversionsTable.$inferSelect;
