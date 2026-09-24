import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { catalogVariantsTable } from '../../catalog/schemas/products.schema.js';

/**
 * Moving stock between branches and counting it — inventory_suppliers.md §٤–§٥.
 */

/**
 * ```
 * requested → approved → in_transit → received            → closed
 *           ↘ rejected            ↘ received_with_discrepancy → closed
 * ```
 * `in_transit` is a state of its own because the goods belong to **no branch**
 * while they travel: counted at the sender they would be sold twice, counted
 * at the receiver they would be sold before they arrive.
 */
export const TRANSFER_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'in_transit',
  'received',
  'received_with_discrepancy',
  'closed',
  'cancelled',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export const transferStatusEnum = pgEnum('stock_transfer_status', TRANSFER_STATUSES);

/** What a manager decided about goods that did not arrive (§٤). */
export const DISCREPANCY_RESOLUTIONS = ['loss', 'returned'] as const;
export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number];
export const discrepancyResolutionEnum = pgEnum('stock_discrepancy_resolution', DISCREPANCY_RESOLUTIONS);

export const stockTransfersTable = pgTable(
  'stock_transfers',
  {
    id: serial('id').primaryKey(),
    /** `TRF-<from branch>-000003` — the sender's run of numbers. */
    number: varchar('number', { length: 40 }).notNull(),
    from_branch_id: integer('from_branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    to_branch_id: integer('to_branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    status: transferStatusEnum('status').notNull(),
    note: text('note'),
    /** Why goods went missing between the two branches — set when the gap is settled. */
    resolution: discrepancyResolutionEnum('resolution'),
    resolution_note: text('resolution_note'),
    requested_by_user_id: integer('requested_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    approved_by_user_id: integer('approved_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    shipped_by_user_id: integer('shipped_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    received_by_user_id: integer('received_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    shipped_at: timestamp('shipped_at', { withTimezone: true }),
    received_at: timestamp('received_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    numberUnique: uniqueIndex('stock_transfers_number_unique').on(table.number),
    fromIdx: index('stock_transfers_from_idx').on(table.from_branch_id, table.status),
    toIdx: index('stock_transfers_to_idx').on(table.to_branch_id, table.status),
  }),
);

/**
 * Three quantities, never one: what was asked for, what actually left, and
 * what actually arrived. Overwriting the first with the second would erase
 * the fact that the sender short-shipped, and the third is the only number
 * the receiving branch can vouch for.
 */
export const stockTransferLinesTable = pgTable(
  'stock_transfer_lines',
  {
    id: serial('id').primaryKey(),
    transfer_id: integer('transfer_id')
      .notNull()
      .references(() => stockTransfersTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    qty_requested: numeric('qty_requested', { precision: 14, scale: 3 }).notNull(),
    qty_shipped: numeric('qty_shipped', { precision: 14, scale: 3 }),
    qty_received: numeric('qty_received', { precision: 14, scale: 3 }),
    /** The sender's cost travels with the goods — no branch profits from another (§٣). */
    unit_cost_syp: numeric('unit_cost_syp', { precision: 14, scale: 2 }),
    unit_cost_usd: numeric('unit_cost_usd', { precision: 14, scale: 4 }),
  },
  (table) => ({
    transferIdx: index('stock_transfer_lines_transfer_idx').on(table.transfer_id),
  }),
);

/** A partial count («رفّ الأقلام») or the annual full one (§٥). */
export const COUNT_SCOPES = ['full', 'category', 'list'] as const;
export type CountScope = (typeof COUNT_SCOPES)[number];
export const countScopeEnum = pgEnum('stock_count_scope', COUNT_SCOPES);

export const COUNT_STATUSES = ['open', 'pending_approval', 'closed', 'cancelled'] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];
export const countStatusEnum = pgEnum('stock_count_status', COUNT_STATUSES);

/**
 * A stocktake. The branch keeps trading while it runs (§٥), so each line
 * stores the system quantity **at the moment that item was scanned** — the
 * difference is measured against that instant, not against a number captured
 * when the session opened and already stale by the second item.
 */
export const stockCountsTable = pgTable(
  'stock_counts',
  {
    id: serial('id').primaryKey(),
    number: varchar('number', { length: 40 }).notNull(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    scope: countScopeEnum('scope').notNull(),
    /** For a category count — the subtree that was walked. */
    category_id: integer('category_id'),
    status: countStatusEnum('status').notNull(),
    note: text('note'),
    /** The value of everything that did not match, at the average cost of the moment. */
    diff_value_syp: numeric('diff_value_syp', { precision: 14, scale: 2 }),
    started_by_user_id: integer('started_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    decided_by_user_id: integer('decided_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    closed_at: timestamp('closed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    numberUnique: uniqueIndex('stock_counts_number_unique').on(table.number),
    branchIdx: index('stock_counts_branch_idx').on(table.branch_id, table.status),
  }),
);

export const stockCountLinesTable = pgTable(
  'stock_count_lines',
  {
    id: serial('id').primaryKey(),
    count_id: integer('count_id')
      .notNull()
      .references(() => stockCountsTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'restrict' }),
    counted_qty: numeric('counted_qty', { precision: 14, scale: 3 }).notNull(),
    /** What the system held when this line was scanned — never shown while the count is open (blind count, §٥). */
    system_qty: numeric('system_qty', { precision: 14, scale: 3 }).notNull(),
    unit_cost_syp: numeric('unit_cost_syp', { precision: 14, scale: 2 }).notNull(),
    counted_by_user_id: integer('counted_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    counted_at: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    countIdx: index('stock_count_lines_count_idx').on(table.count_id),
    // One line per item per count: a second scan corrects the first rather
    // than adding to it, or a shelf counted twice reads as double the stock.
    variantUnique: uniqueIndex('stock_count_lines_variant_unique').on(table.count_id, table.variant_id),
  }),
);

export type StockTransferRow = typeof stockTransfersTable.$inferSelect;
export type StockTransferLineRow = typeof stockTransferLinesTable.$inferSelect;
export type StockCountRow = typeof stockCountsTable.$inferSelect;
export type StockCountLineRow = typeof stockCountLinesTable.$inferSelect;
