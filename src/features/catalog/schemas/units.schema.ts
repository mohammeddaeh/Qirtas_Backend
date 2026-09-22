import { boolean, integer, pgTable, serial, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Units a quantity can be counted in — piece, box, ream, metre, kilogram.
 *
 * A unit is only a **name** here. How many pieces a box holds is a fact about
 * one variant (a box of pens ≠ a box of erasers), recorded with the variant.
 *
 * `allows_fraction` is what makes «2.5 metres of wrapping paper» and «0.75 kg
 * of clay» legal while «2.5 pens» is refused. Quantities are `numeric(14,3)`
 * everywhere from the first migration — converting integer quantities after
 * stock movements exist is the migration nobody wants to write.
 */
export const catalogUnitsTable = pgTable('catalog_units', {
  id: serial('id').primaryKey(),
  /** Stable identity for seeded units (`piece`, `box`, …); `null` for units an admin adds. */
  code: varchar('code', { length: 40 }).unique(),
  name_ar: varchar('name_ar', { length: 60 }).notNull(),
  name_en: varchar('name_en', { length: 60 }),
  allows_fraction: boolean('allows_fraction').notNull().default(false),
  is_active: boolean('is_active').notNull().default(true),
  sort_order: integer('sort_order').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CatalogUnitRow = typeof catalogUnitsTable.$inferSelect;
export type NewCatalogUnitRow = typeof catalogUnitsTable.$inferInsert;
