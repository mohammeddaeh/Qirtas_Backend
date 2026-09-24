import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { mediaAssetsTable } from '../../../core/media/schemas/media-assets.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { pricePolicyEnum, pricingCurrencyEnum, productKindEnum } from './catalog-enums.schema.js';
import { catalogCategoriesTable } from './categories.schema.js';
import { catalogBrandsTable } from './brands.schema.js';
import { catalogUnitsTable } from './units.schema.js';
import { catalogAttributeTypesTable, catalogAttributeValuesTable } from './attributes.schema.js';

/**
 * `draft` — being prepared, invisible to customers. `active` — sellable.
 * `discontinued` — no longer sold, still shown to staff and on past orders.
 */
export const PRODUCT_STATUSES = ['draft', 'active', 'discontinued'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const productStatusEnum = pgEnum('catalog_product_status', PRODUCT_STATUSES);

export const VARIANT_STATUSES = ['active', 'discontinued'] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];
export const variantStatusEnum = pgEnum('catalog_variant_status', VARIANT_STATUSES);

export const BARCODE_SOURCES = ['manufacturer', 'internal'] as const;
export type BarcodeSource = (typeof BARCODE_SOURCES)[number];
export const barcodeSourceEnum = pgEnum('catalog_barcode_source', BARCODE_SOURCES);

/**
 * The product: what is shared by every variant — name, description, category,
 * brand, images. Defined once, centrally (store_system.md §١): the alternative
 * — each branch its own — is the same pen sixteen times.
 */
export const catalogProductsTable = pgTable(
  'catalog_products',
  {
    id: serial('id').primaryKey(),
    /** Must be a leaf category — the service refuses a category that has live subcategories. */
    category_id: integer('category_id')
      .notNull()
      .references(() => catalogCategoriesTable.id, { onDelete: 'restrict' }),
    brand_id: integer('brand_id').references(() => catalogBrandsTable.id, { onDelete: 'restrict' }),
    kind: productKindEnum('kind').notNull(),
    /** A raw material or blank may be kept off sale even where its kind would allow it. */
    is_sellable: boolean('is_sellable').notNull().default(true),
    name_ar: varchar('name_ar', { length: 200 }).notNull(),
    name_en: varchar('name_en', { length: 200 }),
    description_ar: text('description_ar'),
    description_en: text('description_en'),
    /** Synonyms a customer types: «بير» for «قلم حبر جاف». Shown nowhere, searched always. */
    search_keywords: text('search_keywords').array().notNull().default([]),
    /** Folded names + keywords (core/i18n/arabic-normalize.ts), maintained by the service. */
    search_text: text('search_text').notNull(),
    /** `null` = inherit from the category. */
    price_policy: pricePolicyEnum('price_policy'),
    pricing_currency: pricingCurrencyEnum('pricing_currency'),
    /** Overrides the category's `branch_banded` range. `null` = inherit. */
    price_band_percent: numeric('price_band_percent', { precision: 5, scale: 2 }),
    status: productStatusEnum('status').notNull().default('draft'),
    /**
     * A branch met this at its counter as an unknown barcode and created it to
     * receive against (inventory_suppliers.md §٢). It holds stock and **cannot
     * be sold** until the administration approves it: its name, category and
     * picture are nobody's decision yet.
     */
    is_branch_draft: boolean('is_branch_draft').notNull().default(false),
    draft_branch_id: integer('draft_branch_id').references(() => branchesTable.id, { onDelete: 'set null' }),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, {
      onDelete: 'set null',
    }),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    categoryIdx: index('catalog_products_category_idx').on(table.category_id),
    brandIdx: index('catalog_products_brand_idx').on(table.brand_id),
  }),
);

/**
 * A sellable thing with its own stock: «قلم جل أزرق 0.5». A product with no
 * options has exactly one variant with no attribute values.
 */
export const catalogVariantsTable = pgTable(
  'catalog_variants',
  {
    id: serial('id').primaryKey(),
    product_id: integer('product_id')
      .notNull()
      .references(() => catalogProductsTable.id, { onDelete: 'restrict' }),
    sku: varchar('sku', { length: 40 }).notNull().unique(),
    /** Sorted attribute-value ids — unique per product, so two variants can never be the same one. */
    combination_key: varchar('combination_key', { length: 60 }).notNull(),
    /** The unit stock is counted in. Every other unit of this variant is a multiple of it. */
    base_unit_id: integer('base_unit_id')
      .notNull()
      .references(() => catalogUnitsTable.id, { onDelete: 'restrict' }),
    status: variantStatusEnum('status').notNull().default('active'),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    combinationUnique: uniqueIndex('catalog_variants_product_combination_unique').on(
      table.product_id,
      table.combination_key,
    ),
  }),
);

export const catalogVariantAttributeValuesTable = pgTable(
  'catalog_variant_attribute_values',
  {
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'cascade' }),
    attribute_type_id: integer('attribute_type_id')
      .notNull()
      .references(() => catalogAttributeTypesTable.id, { onDelete: 'restrict' }),
    attribute_value_id: integer('attribute_value_id')
      .notNull()
      .references(() => catalogAttributeValuesTable.id, { onDelete: 'restrict' }),
  },
  // One value per attribute per variant, enforced by the key itself.
  (table) => ({ pk: primaryKey({ columns: [table.variant_id, table.attribute_type_id] }) }),
);

/**
 * Units a variant can be counted in. The base unit is always a row here with
 * factor 1, so a barcode always points at one row regardless of unit.
 *
 * `factor` is how many base units one of this unit holds — `numeric(14,3)`,
 * because a roll can hold 2.5 metres. Price per unit belongs to pricing
 * (phase 2); here is only what the unit *is*.
 */
export const catalogVariantUnitsTable = pgTable(
  'catalog_variant_units',
  {
    id: serial('id').primaryKey(),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'cascade' }),
    unit_id: integer('unit_id')
      .notNull()
      .references(() => catalogUnitsTable.id, { onDelete: 'restrict' }),
    factor: numeric('factor', { precision: 14, scale: 3 }).notNull(),
    is_base: boolean('is_base').notNull().default(false),
    sellable_online: boolean('sellable_online').notNull().default(true),
    sellable_at_pos: boolean('sellable_at_pos').notNull().default(true),
  },
  (table) => ({
    variantUnitUnique: uniqueIndex('catalog_variant_units_variant_unit_unique').on(
      table.variant_id,
      table.unit_id,
    ),
  }),
);

/**
 * Unique on (code, variant_unit) — NOT on code. See `services/barcode-rules.ts`
 * for why a factory's shared code must be accepted and resolved, not refused.
 */
export const catalogBarcodesTable = pgTable(
  'catalog_barcodes',
  {
    id: serial('id').primaryKey(),
    code: varchar('code', { length: 32 }).notNull(),
    variant_unit_id: integer('variant_unit_id')
      .notNull()
      .references(() => catalogVariantUnitsTable.id, { onDelete: 'cascade' }),
    source: barcodeSourceEnum('source').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeUnitUnique: uniqueIndex('catalog_barcodes_code_unit_unique').on(
      table.code,
      table.variant_unit_id,
    ),
    codeIdx: index('catalog_barcodes_code_idx').on(table.code),
  }),
);

/** Running number behind internal EAN-13 codes (`20` + 10 digits + check). Never reused. */
export const catalogInternalBarcodeSeq = pgSequence('catalog_internal_barcode_seq', {
  startWith: 1,
});

/** Images of a product; `variant_id` set = shown when that variant (a colour) is selected. */
export const catalogProductMediaTable = pgTable(
  'catalog_product_media',
  {
    id: serial('id').primaryKey(),
    product_id: integer('product_id')
      .notNull()
      .references(() => catalogProductsTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id').references(() => catalogVariantsTable.id, {
      onDelete: 'cascade',
    }),
    media_id: integer('media_id')
      .notNull()
      .references(() => mediaAssetsTable.id, { onDelete: 'restrict' }),
    sort_order: integer('sort_order').notNull().default(0),
  },
  (table) => ({ productIdx: index('catalog_product_media_product_idx').on(table.product_id) }),
);

export type CatalogProductRow = typeof catalogProductsTable.$inferSelect;
export type NewCatalogProductRow = typeof catalogProductsTable.$inferInsert;
export type CatalogVariantRow = typeof catalogVariantsTable.$inferSelect;
export type NewCatalogVariantRow = typeof catalogVariantsTable.$inferInsert;
export type CatalogVariantValueRow = typeof catalogVariantAttributeValuesTable.$inferSelect;
export type CatalogVariantUnitRow = typeof catalogVariantUnitsTable.$inferSelect;
export type NewCatalogVariantUnitRow = typeof catalogVariantUnitsTable.$inferInsert;
export type CatalogBarcodeRow = typeof catalogBarcodesTable.$inferSelect;
export type CatalogProductMediaRow = typeof catalogProductMediaTable.$inferSelect;
