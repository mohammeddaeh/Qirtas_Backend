import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { pricingCurrencyEnum } from './catalog-enums.schema.js';
import { catalogVariantsTable } from './products.schema.js';

/**
 * Pricing — docs/reference/store_system.md §١١ (phase 2).
 *
 * Every price row stores its **own currency**. Reading it from the product's
 * effective currency at display time would reinterpret every stored number the
 * day a category switches from SYP to USD: «2500» would become 2500 dollars.
 *
 * Amounts are `numeric(14,2)` and arrive from the driver as strings — `Number()`
 * at the edge, never float arithmetic on the column type.
 */

/** The central price of a variant, plus its optional explicit wholesale price. */
export const catalogVariantPricesTable = pgTable('catalog_variant_prices', {
  variant_id: integer('variant_id')
    .primaryKey()
    .references(() => catalogVariantsTable.id, { onDelete: 'cascade' }),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  currency: pricingCurrencyEnum('currency').notNull(),
  /** Beats the category's wholesale discount when set. Same currency as [amount]. */
  wholesale_amount: numeric('wholesale_amount', { precision: 14, scale: 2 }),
  /** In base units. `null` = the category's (inherited) minimum. */
  wholesale_min_qty: numeric('wholesale_min_qty', { precision: 14, scale: 3 }),
  updated_by_user_id: integer('updated_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A branch's price for a variant. Under `central_locked` it is the
 * administration's exception for that branch; under `branch_free` /
 * `branch_banded` it is the branch's own. Absent = the central price.
 *
 * Cascades with the branch: a price is configuration, and a branch can only be
 * deleted when nothing ever happened there.
 */
export const catalogBranchPricesTable = pgTable(
  'catalog_branch_prices',
  {
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: pricingCurrencyEnum('currency').notNull(),
    updated_by_user_id: integer('updated_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branch_id, table.variant_id] }),
    variantIdx: index('catalog_branch_prices_variant_idx').on(table.variant_id),
  }),
);

/** Withdrawn from a branch. **No row = listed**: a published product is on sale everywhere by default. */
export const catalogBranchListingsTable = pgTable(
  'catalog_branch_listings',
  {
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'cascade' }),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'cascade' }),
    is_listed: boolean('is_listed').notNull(),
    updated_by_user_id: integer('updated_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branch_id, table.variant_id] }),
  }),
);

/** USD → SYP. Appended, never edited: a sale stores the rate it used, and history must agree with it. */
export const catalogExchangeRatesTable = pgTable('catalog_exchange_rates', {
  id: serial('id').primaryKey(),
  usd_to_syp: numeric('usd_to_syp', { precision: 14, scale: 2 }).notNull(),
  effective_at: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
  created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
});

/** Single row (`id = 1`) — the rounding bands. */
export const catalogPricingSettingsTable = pgTable('catalog_pricing_settings', {
  id: smallint('id').primaryKey(),
  /** `[{ below: 1000, step: 50 }, { below: 10000, step: 100 }, { below: null, step: 500 }]` */
  rounding_bands: jsonb('rounding_bands').$type<{ below: number | null; step: number }[]>().notNull(),
  updated_by_user_id: integer('updated_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every price change: who, when, from what to what. `branch_id` null = central.
 * `field`: `retail` · `wholesale` · `wholesale_min_qty`. `source`: `manual` · `bulk`.
 */
export const catalogPriceHistoryTable = pgTable(
  'catalog_price_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    variant_id: integer('variant_id')
      .notNull()
      .references(() => catalogVariantsTable.id, { onDelete: 'cascade' }),
    branch_id: integer('branch_id').references(() => branchesTable.id, { onDelete: 'cascade' }),
    field: varchar('field', { length: 24 }).notNull(),
    old_amount: numeric('old_amount', { precision: 14, scale: 3 }),
    old_currency: pricingCurrencyEnum('old_currency'),
    new_amount: numeric('new_amount', { precision: 14, scale: 3 }),
    new_currency: pricingCurrencyEnum('new_currency'),
    source: varchar('source', { length: 12 }).notNull(),
    changed_by_user_id: integer('changed_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    changed_at: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    variantIdx: index('catalog_price_history_variant_idx').on(table.variant_id, table.changed_at),
  }),
);

export type VariantPriceRow = typeof catalogVariantPricesTable.$inferSelect;
export type BranchPriceRow = typeof catalogBranchPricesTable.$inferSelect;
export type PriceHistoryRow = typeof catalogPriceHistoryTable.$inferSelect;
