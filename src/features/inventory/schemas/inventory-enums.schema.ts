import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Stock — docs/reference/inventory_suppliers.md §٢ and §٨.
 *
 * Every quantity change in the shop is one of these, and the ledger is
 * append-only: a correction is an opposite movement, never an edit. That is
 * what lets a balance be rebuilt from the ledger and disagree with nothing.
 */
export const STOCK_MOVEMENT_TYPES = [
  'receipt',
  'sale',
  'return_in',
  'return_to_supplier',
  'transfer_out',
  'transfer_in',
  'count_adjustment',
  'damage',
  'production_consume',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export const stockMovementTypeEnum = pgEnum('stock_movement_type', STOCK_MOVEMENT_TYPES);

/** What a document is, for the movement's `source_doc_type` and for numbering. */
export const INVENTORY_DOC_TYPES = ['receipt', 'adjustment', 'transfer', 'count', 'return'] as const;
export type InventoryDocType = (typeof INVENTORY_DOC_TYPES)[number];
export const inventoryDocTypeEnum = pgEnum('inventory_doc_type', INVENTORY_DOC_TYPES);

/**
 * Why stock left without a sale. Required on every adjustment (§٨): «نقص ٣»
 * with no reason is a number nobody can act on, and the same three pieces
 * disappearing every month is only visible when each time said why.
 */
export const ADJUSTMENT_REASONS = ['damage', 'loss', 'expiry', 'sample', 'internal_use', 'other'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export const adjustmentReasonEnum = pgEnum('stock_adjustment_reason', ADJUSTMENT_REASONS);

/**
 * An adjustment above the configured value waits for a manager; below it, it
 * posts on creation. `posted` is terminal either way — the movements exist.
 */
export const ADJUSTMENT_STATUSES = ['pending_approval', 'posted', 'rejected'] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];
export const adjustmentStatusEnum = pgEnum('stock_adjustment_status', ADJUSTMENT_STATUSES);
