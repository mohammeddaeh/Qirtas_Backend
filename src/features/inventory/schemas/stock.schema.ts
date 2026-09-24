import {
  bigserial,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import {
  adjustmentReasonEnum,
  adjustmentStatusEnum,
  inventoryDocTypeEnum,
  stockMovementTypeEnum,
} from './inventory-enums.schema.js';

/**
 * Stock — docs/reference/inventory_suppliers.md §٢–§٨.
 *
 * Quantities are `numeric(14,3)` **in the variant's base unit, always**: a
 * box of twelve is stored as twelve, so no report has to know which unit a
 * row was typed in. Fractions are there from the start — metres, kilos, mils.
 */

/**
 * The ledger. Append-only: nothing here is edited or deleted, and a mistake is
 * corrected by an opposite movement. It is the record; `stock_balances` below
 * is only a cache of it.
 */
export const stockMovementsTable = pgTable(
  'stock_movements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    type: stockMovementTypeEnum('type').notNull(),
    /** Signed: in is positive, out is negative. */
    qty_base: numeric('qty_base', { precision: 14, scale: 3 }).notNull(),
    /** The cost this movement carried, in both currencies (§٣) — `null` for an issue priced by the average. */
    unit_cost_syp: numeric('unit_cost_syp', { precision: 14, scale: 2 }),
    unit_cost_usd: numeric('unit_cost_usd', { precision: 14, scale: 4 }),
    source_doc_type: inventoryDocTypeEnum('source_doc_type'),
    source_doc_id: integer('source_doc_id'),
    note: text('note'),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    branchVariantIdx: index('stock_movements_branch_variant_idx').on(
      table.branch_id,
      table.variant_id,
      table.created_at,
    ),
    docIdx: index('stock_movements_doc_idx').on(table.source_doc_type, table.source_doc_id),
  }),
);

/**
 * The balance of one variant at one branch — a cache of the ledger, written in
 * the same transaction as every movement and rebuildable from it.
 *
 * `reorder_threshold` lives here because the branch owns it (§٨): the same pen
 * runs low at 5 in a kiosk and at 50 in the main shop.
 */
export const stockBalancesTable = pgTable(
  'stock_balances',
  {
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    /** May go negative at the counter (§٨) — and every negative is a signal to count that item. */
    on_hand: numeric('on_hand', { precision: 14, scale: 3 }).notNull().default('0'),
    /** Held for confirmed online orders; available = on_hand − reserved. */
    reserved: numeric('reserved', { precision: 14, scale: 3 }).notNull().default('0'),
    avg_cost_syp: numeric('avg_cost_syp', { precision: 14, scale: 2 }).notNull().default('0'),
    avg_cost_usd: numeric('avg_cost_usd', { precision: 14, scale: 4 }).notNull().default('0'),
    reorder_threshold: numeric('reorder_threshold', { precision: 14, scale: 3 }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branch_id, table.variant_id] }),
    variantIdx: index('stock_balances_variant_idx').on(table.variant_id),
  }),
);

/**
 * What each receipt brought and what is left of it. The moving average is the
 * official cost (§٣); these layers are kept because they are cheap and they
 * are what an expiry warning and a future FIFO report read — neither is
 * reconstructible from an average.
 */
export const stockReceiptLayersTable = pgTable(
  'stock_receipt_layers',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    receipt_id: integer('receipt_id').notNull(),
    qty_base: numeric('qty_base', { precision: 14, scale: 3 }).notNull(),
    remaining_base: numeric('remaining_base', { precision: 14, scale: 3 }).notNull(),
    unit_cost_syp: numeric('unit_cost_syp', { precision: 14, scale: 2 }).notNull(),
    unit_cost_usd: numeric('unit_cost_usd', { precision: 14, scale: 4 }).notNull(),
    /** Optional (§٨): glue, ink and gel pens expire; a notebook does not. */
    expires_at: timestamp('expires_at', { withTimezone: true }),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    branchVariantIdx: index('stock_layers_branch_variant_idx').on(table.branch_id, table.variant_id),
    expiryIdx: index('stock_layers_expiry_idx').on(table.expires_at),
  }),
);

/**
 * Gapless per (branch, document type) numbering — `GRN-<branch>-000012`.
 * A shared counter would make one branch's papers jump by another's work.
 */
export const inventoryDocSequencesTable = pgTable(
  'inventory_doc_sequences',
  {
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    doc_type: inventoryDocTypeEnum('doc_type').notNull(),
    last_number: integer('last_number').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branch_id, table.doc_type] }),
  }),
);

/** One row (`id = 1`): the value above which an adjustment waits for a manager, and how early expiry is announced. */
export const inventorySettingsTable = pgTable('inventory_settings', {
  id: smallint('id').primaryKey(),
  approval_threshold_syp: numeric('approval_threshold_syp', { precision: 14, scale: 2 }).notNull(),
  expiry_alert_days: integer('expiry_alert_days').notNull().default(30),
  updated_by_user_id: integer('updated_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Stock leaving without a sale: damage, loss, expiry, a sample given away. */
export const stockAdjustmentsTable = pgTable(
  'stock_adjustments',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    number: varchar('number', { length: 40 }).notNull(),
    reason: adjustmentReasonEnum('reason').notNull(),
    /** Required — §٨. The same three pieces vanishing monthly is only visible when each time said why. */
    note: text('note').notNull(),
    status: adjustmentStatusEnum('status').notNull(),
    /** At the average cost of the moment, so the approval rule reads one number. */
    total_value_syp: numeric('total_value_syp', { precision: 14, scale: 2 }).notNull(),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    decided_by_user_id: integer('decided_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    numberUnique: uniqueIndex('stock_adjustments_number_unique').on(table.number),
    branchIdx: index('stock_adjustments_branch_idx').on(table.branch_id, table.created_at),
  }),
);

export const stockAdjustmentLinesTable = pgTable(
  'stock_adjustment_lines',
  {
    id: serial('id').primaryKey(),
    adjustment_id: integer('adjustment_id')
      .notNull()
      .references(() => stockAdjustmentsTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    /** Positive: how much leaves. The movement it posts is negative. */
    qty_base: numeric('qty_base', { precision: 14, scale: 3 }).notNull(),
    unit_cost_syp: numeric('unit_cost_syp', { precision: 14, scale: 2 }).notNull(),
  },
  (table) => ({
    adjustmentIdx: index('stock_adjustment_lines_adjustment_idx').on(table.adjustment_id),
  }),
);

export type StockMovementRow = typeof stockMovementsTable.$inferSelect;
export type StockBalanceRow = typeof stockBalancesTable.$inferSelect;
export type StockAdjustmentRow = typeof stockAdjustmentsTable.$inferSelect;
export type StockAdjustmentLineRow = typeof stockAdjustmentLinesTable.$inferSelect;
