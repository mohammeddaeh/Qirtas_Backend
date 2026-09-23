import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  timestamp,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { mediaAssetsTable } from '../../../core/media/schemas/media-assets.schema.js';
import { pricePolicyEnum, pricingCurrencyEnum, productKindEnum } from './catalog-enums.schema.js';
import { catalogAttributeTypesTable } from './attributes.schema.js';

/**
 * The category tree — three levels at most (أدوات الكتابة ← أقلام ← جاف).
 *
 * A product has exactly ONE category, because the category decides the
 * pricing policy, currency, product kind and allowed attributes: a product in
 * two categories would have two competing answers to each. Marketing groupings
 * that cut across the tree are collections, not categories.
 *
 * `price_policy`, `pricing_currency` and `product_kind` are `null` to mean
 * "inherit from the parent". The effective value is computed by walking up,
 * never copied down — a copy would go stale the day the parent changes.
 */
export const catalogCategoriesTable = pgTable(
  'catalog_categories',
  {
    id: serial('id').primaryKey(),
    /** Stable identity for seeded categories, so re-seeding never duplicates one an admin renamed. */
    code: varchar('code', { length: 60 }).unique(),
    parent_id: integer('parent_id').references((): AnyPgColumn => catalogCategoriesTable.id, {
      onDelete: 'restrict',
    }),
    /** 1–3, derived from the parent and maintained by the service. Stored so the depth rule is checkable without a recursive query. */
    level: smallint('level').notNull(),
    name_ar: varchar('name_ar', { length: 120 }).notNull(),
    name_en: varchar('name_en', { length: 120 }),
    product_kind: productKindEnum('product_kind'),
    price_policy: pricePolicyEnum('price_policy'),
    pricing_currency: pricingCurrencyEnum('pricing_currency'),
    /** Pricing (store_system.md §١١) — all `null` = inherit. `branch_banded` range: ± this % of the central price. */
    price_band_percent: numeric('price_band_percent', { precision: 5, scale: 2 }),
    /** Wholesale = retail × (1 − this %), unless a variant sets an explicit wholesale price. */
    wholesale_discount_percent: numeric('wholesale_discount_percent', { precision: 5, scale: 2 }),
    /** Minimum quantity (base units) for the wholesale price to apply. */
    wholesale_min_qty: numeric('wholesale_min_qty', { precision: 14, scale: 3 }),
    /** Included in the shelf price (prices are tax-inclusive); the invoice splits it out. */
    tax_rate_percent: numeric('tax_rate_percent', { precision: 5, scale: 2 }),
    image_id: integer('image_id').references(() => mediaAssetsTable.id, { onDelete: 'set null' }),
    sort_order: integer('sort_order').notNull().default(0),
    /** Hidden from customers while false; still pickable by staff. */
    is_active: boolean('is_active').notNull().default(true),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    parentIdx: index('catalog_categories_parent_idx').on(table.parent_id),
  }),
);

/**
 * Which library attributes a category's products may use. Inherited by the
 * subtree: «الدفاتر والورق» allowing «مقاس الورق» lets every notebook use it.
 */
export const catalogCategoryAttributesTable = pgTable(
  'catalog_category_attributes',
  {
    category_id: integer('category_id')
      .notNull()
      .references(() => catalogCategoriesTable.id, { onDelete: 'cascade' }),
    attribute_type_id: integer('attribute_type_id')
      .notNull()
      .references(() => catalogAttributeTypesTable.id, { onDelete: 'restrict' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.category_id, table.attribute_type_id] }),
  }),
);

export type CatalogCategoryRow = typeof catalogCategoriesTable.$inferSelect;
export type NewCatalogCategoryRow = typeof catalogCategoriesTable.$inferInsert;
export type CatalogCategoryAttributeRow = typeof catalogCategoryAttributesTable.$inferSelect;
