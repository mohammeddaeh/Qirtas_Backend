import { z } from 'zod';
import { PRICING_CURRENCIES } from '../../catalog/schemas/catalog-enums.schema.js';
import { ADJUSTMENT_REASONS, type AdjustmentReason, type AdjustmentStatus, type StockMovementType } from '../schemas/inventory-enums.schema.js';
import type { StockFlag } from '../services/stock-rules.js';

/** Stock — inventory_suppliers.md §٢–§٨, rest_api.md §22. */

export const qtySchema = z.number().positive().max(1_000_000_000);
const branchIdSchema = z.coerce.number().int().positive();

export const branchScopeQuerySchema = z.object({ branch_id: branchIdSchema }).strict();
export type BranchScopeQuery = z.infer<typeof branchScopeQuerySchema>;

export const stockFilterQuerySchema = z
  .object({
    branch_id: branchIdSchema,
    search: z.string().trim().min(1).max(100).optional(),
    /** `low` also covers out-of-stock and negative — one filter for "needs attention". */
    flag: z.enum(['low', 'negative', 'out_of_stock']).optional(),
  })
  .strict();
export type StockFilterQuery = z.infer<typeof stockFilterQuerySchema>;

export const movementsFilterQuerySchema = z
  .object({ branch_id: branchIdSchema, variant_id: z.coerce.number().int().positive().optional() })
  .strict();
export type MovementsFilterQuery = z.infer<typeof movementsFilterQuerySchema>;

export const thresholdBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    /** `null` clears it: "no threshold" is a real answer, not zero. */
    threshold: z.number().min(0).max(1_000_000).nullable(),
  })
  .strict();
export type ThresholdBody = z.infer<typeof thresholdBodySchema>;

export const inventorySettingsBodySchema = z
  .object({
    approval_threshold_syp: z.number().min(0).max(1_000_000_000),
    expiry_alert_days: z.number().int().min(1).max(365),
  })
  .strict();
export type InventorySettingsBody = z.infer<typeof inventorySettingsBodySchema>;

export const receiptBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    supplier_id: z.number().int().positive(),
    supplier_invoice_no: z.string().trim().max(60).nullable().optional(),
    invoice_date: z.string().datetime({ offset: true }),
    currency: z.enum(PRICING_CURRENCIES),
    /** Required for a dollar invoice — cost is recorded in both currencies. */
    exchange_rate: z.number().positive().max(100_000_000).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    lines: z
      .array(
        z
          .object({
            variant_id: z.number().int().positive(),
            /** The unit as written on the invoice (a carton), not the base unit. */
            unit_id: z.number().int().positive(),
            qty: qtySchema,
            unit_cost: z.number().min(0).max(1_000_000_000),
            expires_at: z.string().datetime({ offset: true }).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type ReceiptBody = z.infer<typeof receiptBodySchema>;

/**
 * The filters `listReceipts` already reads — declared, because a query key the
 * schema does not name never reaches the controller.
 *
 * The route validated `page`/`limit` alone under `.strict()`, so
 * `?branch_id=32` was refused **422 with an empty `errors` map** (a strict
 * violation lands in zod's `formErrors`, and `validate()` sends `fieldErrors`),
 * and the app showed "Validation failed" with nothing to act on. Dropping
 * `.strict()` alone would have been worse: `validate()` replaces `req.query`
 * with the parsed value, so the filter would have been silently stripped and
 * the branch picker would have listed every branch's receipts with a 200.
 */
export const receiptsFilterQuerySchema = z
  .object({
    branch_id: branchIdSchema.optional(),
    supplier_id: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type ReceiptsFilterQuery = z.infer<typeof receiptsFilterQuerySchema>;

export const adjustmentBodySchema = z
  .object({
    branch_id: z.number().int().positive(),
    reason: z.enum(ADJUSTMENT_REASONS),
    /** Required: «نقص ٣» with no reason is a number nobody can act on (§٨). */
    note: z.string().trim().min(1).max(500),
    lines: z
      .array(z.object({ variant_id: z.number().int().positive(), qty_base: qtySchema }).strict())
      .min(1)
      .max(200),
  })
  .strict();
export type AdjustmentBody = z.infer<typeof adjustmentBodySchema>;

export const adjustmentsFilterQuerySchema = z
  .object({
    branch_id: branchIdSchema.optional(),
    status: z.enum(['pending_approval', 'posted', 'rejected']).optional(),
  })
  .strict();
export type AdjustmentsFilterQuery = z.infer<typeof adjustmentsFilterQuerySchema>;

// ── Responses ───────────────────────────────────────────────────────────────

export interface WireStockRow {
  variant_id: number;
  product_id: number;
  product_name_ar: string;
  product_name_en: string | null;
  sku: string;
  on_hand: number;
  reserved: number;
  available: number;
  avg_cost_syp: number;
  avg_cost_usd: number;
  reorder_threshold: number | null;
  /** The server's reading of the row — the client colours it, never computes it. */
  flag: StockFlag;
}

export interface WireMovement {
  id: number;
  variant_id: number;
  sku: string;
  product_name_ar: string;
  type: StockMovementType;
  qty_base: number;
  unit_cost_syp: number | null;
  source_doc_type: string | null;
  source_doc_id: number | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

export const documentItemsQuerySchema = z
  .object({
    branch_id: z.coerce.number().int().positive(),
    search: z.string().trim().min(1).max(100),
  })
  .strict();
export type DocumentItemsQuery = z.infer<typeof documentItemsQuerySchema>;

/**
 * An item a receiving or damage line may name, with the units it can be
 * written in and what the branch already holds of it.
 */
export interface WireDocumentItem {
  variant_id: number;
  sku: string;
  product_name_ar: string;
  base_unit_id: number;
  on_hand: number;
  units: { unit_id: number; unit_name_ar: string; factor: number; is_base: boolean }[];
}

export interface WireInventorySettings {
  approval_threshold_syp: number;
  expiry_alert_days: number;
  /**
   * Which branches an inventory screen may work at. Sent here because every
   * one of those screens asks the question first, and the client must not
   * reach into the branches module to answer it.
   */
  branches: { id: number; name: string }[];
}

export interface WireReceiptLine {
  variant_id: number;
  sku: string;
  product_name_ar: string;
  unit_id: number;
  unit_name_ar: string;
  qty: number;
  factor: number;
  qty_base: number;
  unit_cost: number;
  unit_cost_base_syp: number;
  expires_at: string | null;
}

export interface WireReceipt {
  id: number;
  branch_id: number;
  branch_name: string;
  supplier_id: number;
  supplier_name: string;
  number: string;
  supplier_invoice_no: string | null;
  invoice_date: string;
  currency: 'SYP' | 'USD';
  exchange_rate: number | null;
  total_syp: number;
  total_usd: number;
  note: string | null;
  created_at: string;
  created_by: string | null;
  lines: WireReceiptLine[];
}

export interface WireAdjustmentLine {
  variant_id: number;
  sku: string;
  product_name_ar: string;
  qty_base: number;
  unit_cost_syp: number;
}

export interface WireAdjustment {
  id: number;
  branch_id: number;
  number: string;
  reason: AdjustmentReason;
  note: string;
  status: AdjustmentStatus;
  total_value_syp: number;
  created_at: string;
  decided_at: string | null;
  lines: WireAdjustmentLine[];
}

export interface WireStockSignals {
  branch_id: number;
  /** Below the branch's own threshold — what to reorder. */
  low_count: number;
  out_of_stock_count: number;
  /** A contradiction, not a shortage: these ask for a stocktake (§٨). */
  negative_count: number;
  pending_adjustments: number;
  expiring: { variant_id: number; sku: string; product_name_ar: string; remaining_base: number; expires_at: string }[];
}
