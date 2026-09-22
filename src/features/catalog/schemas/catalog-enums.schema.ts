import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Who decides a price (docs/reference/store_system.md §٣). Set on a category
 * and inherited by its subtree; a product may override it. `null` on a row
 * means "inherit".
 */
export const PRICE_POLICIES = ['central_locked', 'branch_free', 'branch_banded'] as const;
export type PricePolicy = (typeof PRICE_POLICIES)[number];
export const pricePolicyEnum = pgEnum('catalog_price_policy', PRICE_POLICIES);

/** The currency a price is *set* in. Sales are always in SYP; a USD price converts at the current rate. */
export const PRICING_CURRENCIES = ['SYP', 'USD'] as const;
export type PricingCurrency = (typeof PRICING_CURRENCIES)[number];
export const pricingCurrencyEnum = pgEnum('catalog_pricing_currency', PRICING_CURRENCIES);

/**
 * What a product is for. `blank` (a white mug waiting for a design) and
 * `raw_material` (print paper, toner) live in the same catalog and the same
 * stock ledger as retail goods, so there are not three systems; the kind
 * decides where a product is shown, never who may consume it.
 */
export const PRODUCT_KINDS = ['retail', 'blank', 'raw_material'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];
export const productKindEnum = pgEnum('catalog_product_kind', PRODUCT_KINDS);

/** How an attribute's values are drawn: a colour swatch or a text chip. */
export const ATTRIBUTE_DISPLAYS = ['swatch', 'text'] as const;
export type AttributeDisplay = (typeof ATTRIBUTE_DISPLAYS)[number];
export const attributeDisplayEnum = pgEnum('catalog_attribute_display', ATTRIBUTE_DISPLAYS);
