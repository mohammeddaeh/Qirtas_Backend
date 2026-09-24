import { z } from 'zod';
import { PRICING_CURRENCIES, type PricePolicy, type PricingCurrency } from '../schemas/catalog-enums.schema.js';
import type { PriceSource, RoundingBand } from '../services/price-resolution.js';

/** Pricing — store_system.md §١١, rest_api.md §21. */

const amountSchema = z.number().positive().max(1_000_000_000_000);
const currencySchema = z.enum(PRICING_CURRENCIES);

export const branchVariantParamsSchema = z.object({
  branchId: z.coerce.number().int().positive(),
  variantId: z.coerce.number().int().positive(),
});
export const branchParamsSchema = z.object({ branchId: z.coerce.number().int().positive() });

/** `?branch_id=` — absent = the central view. */
export const pricingViewQuerySchema = z
  .object({ branch_id: z.coerce.number().int().positive().optional() })
  .strict();

export const centralPriceBodySchema = z
  .object({
    amount: amountSchema,
    /** Absent = the product's effective currency. */
    currency: currencySchema.optional(),
    wholesale_amount: amountSchema.nullable().optional(),
    wholesale_min_qty: z.number().positive().max(1_000_000).nullable().optional(),
  })
  .strict();
export type CentralPriceBody = z.infer<typeof centralPriceBodySchema>;

export const branchPriceBodySchema = z.object({ amount: amountSchema, currency: currencySchema.optional() }).strict();
export type BranchPriceBody = z.infer<typeof branchPriceBodySchema>;

export const listingBodySchema = z.object({ is_listed: z.boolean() }).strict();

export const exchangeRateBodySchema = z.object({ usd_to_syp: z.number().positive().max(100_000_000) }).strict();

export const roundingBodySchema = z
  .object({
    bands: z
      .array(z.object({ below: z.number().positive().nullable(), step: z.number().positive().max(1_000_000) }).strict())
      .min(1)
      .max(10),
  })
  .strict();

export const bulkPriceBodySchema = z
  .object({
    category_id: z.number().int().positive().optional(),
    brand_id: z.number().int().positive().optional(),
    /** −90…+500. Zero changes nothing and is refused as a slip. */
    percent: z.number().min(-90).max(500).refine((p) => p !== 0, { message: 'percent must not be 0' }),
  })
  .strict()
  .refine((b) => (b.category_id === undefined) !== (b.brand_id === undefined), {
    message: 'Give exactly one of category_id or brand_id',
    path: ['category_id'],
  });
export type BulkPriceBody = z.infer<typeof bulkPriceBodySchema>;

const percentSchema = z.number().min(0).max(100).nullable();

/**
 * A category's pricing rules. Every key optional (absent = unchanged), `null`
 * = inherit from the parent — the same convention as the category's policy.
 */
export const categoryPricingRulesBodySchema = z
  .object({
    price_band_percent: percentSchema.optional(),
    wholesale_discount_percent: z.number().min(0).max(90).nullable().optional(),
    wholesale_min_qty: z.number().positive().max(1_000_000).nullable().optional(),
    tax_rate_percent: percentSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });
export type CategoryPricingRulesBody = z.infer<typeof categoryPricingRulesBodySchema>;

/** A product may only override the band — the rest is the category's. */
export const productPricingRulesBodySchema = z.object({ price_band_percent: percentSchema }).strict();

// ── Responses ───────────────────────────────────────────────────────────────

export type WireResolvedPrice =
  | { status: 'not_listed' }
  | { status: 'unpriced'; reason: 'no_price' | 'no_exchange_rate' }
  | {
      status: 'priced';
      amount_syp: number;
      source: PriceSource;
      out_of_band: boolean;
      band: { min: number; max: number } | null;
      wholesale: { amount_syp: number; min_qty: number } | null;
    };

export interface WirePricingSettings {
  exchange_rate: { usd_to_syp: number; effective_at: string } | null;
  rounding_bands: RoundingBand[];
  /**
   * Live branches, so the pricing screens can offer a branch to price for.
   * Sent here because the client's catalog feature may not read the branches
   * feature (`Features → Features ❌`), and every pricing screen needs them.
   */
  branches: { id: number; name: string }[];
}

export interface WireVariantPricing {
  variant_id: number;
  sku: string;
  label_ar: string;
  central: {
    amount: number;
    currency: PricingCurrency;
    wholesale_amount: number | null;
    wholesale_min_qty: number | null;
  } | null;
  /** This branch's own price — the branch view only. */
  branch_price: { amount: number; currency: PricingCurrency } | null;
  is_listed: boolean;
  resolved: WireResolvedPrice;
  /** Every branch's own price — the central view only. */
  branch_prices: { branch_id: number; branch_name: string; amount: number; currency: PricingCurrency }[];
  /** Branches this variant is withdrawn from — the central view only. */
  unlisted_branch_ids: number[];
}

export interface WireProductPricing {
  product_id: number;
  branch_id: number | null;
  price_policy: PricePolicy;
  pricing_currency: PricingCurrency;
  band_percent: number | null;
  /** The product's own band override (`null` = the category's). */
  own_band_percent: number | null;
  wholesale_discount_percent: number | null;
  wholesale_min_qty: number | null;
  tax_rate_percent: number | null;
  exchange_rate: number | null;
  /** The server's answer to "may this caller write here" — the screen shows controls from it, never from a guess. */
  can_edit_central: boolean;
  can_edit_branch: boolean;
  variants: WireVariantPricing[];
}

export interface WirePriceHistoryEntry {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  field: 'retail' | 'wholesale' | 'wholesale_min_qty';
  old_amount: number | null;
  old_currency: PricingCurrency | null;
  new_amount: number | null;
  new_currency: PricingCurrency | null;
  source: 'manual' | 'bulk';
  changed_at: string;
  changed_by: string | null;
}

export interface WireWorklistItem {
  variant_id: number;
  product_id: number;
  product_name_ar: string;
  product_name_en: string | null;
  sku: string;
  label_ar: string;
  problem: 'no_price' | 'no_exchange_rate' | 'out_of_band';
}

export interface WireBulkPreview {
  count: number;
  skipped: number;
  largest_change_syp: number | null;
  smallest_change_syp: number | null;
  samples: {
    variant_id: number;
    sku: string;
    product_name_ar: string;
    currency: PricingCurrency;
    old_amount: number;
    new_amount: number;
  }[];
}
