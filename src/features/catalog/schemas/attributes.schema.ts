import {
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { attributeDisplayEnum } from './catalog-enums.schema.js';

/**
 * The central attribute library — «اللون», «مقاس الورق», «عدد الأوراق».
 *
 * Central, not typed freely per product: free text turns «أحمر», «احمر» and
 * «Red» into three values, and filtering by colour then quietly misses two
 * thirds of the red pens. Nothing fails; the filter is just wrong.
 */
export const catalogAttributeTypesTable = pgTable('catalog_attribute_types', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 40 }).unique(),
  name_ar: varchar('name_ar', { length: 80 }).notNull(),
  name_en: varchar('name_en', { length: 80 }),
  display: attributeDisplayEnum('display').notNull().default('text'),
  sort_order: integer('sort_order').notNull().default(0),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const catalogAttributeValuesTable = pgTable(
  'catalog_attribute_values',
  {
    id: serial('id').primaryKey(),
    attribute_type_id: integer('attribute_type_id')
      .notNull()
      .references(() => catalogAttributeTypesTable.id, { onDelete: 'restrict' }),
    value_ar: varchar('value_ar', { length: 80 }).notNull(),
    value_en: varchar('value_en', { length: 80 }),
    /**
     * Folded form of `value_ar` (core/i18n/arabic-normalize.ts). Unique per type,
     * so «أحمر» and «احمر» cannot both exist under «اللون».
     */
    value_normalized: varchar('value_normalized', { length: 80 }).notNull(),
    /** `#RRGGBB`, only meaningful when the type's display is `swatch`. */
    color_hex: varchar('color_hex', { length: 7 }),
    sort_order: integer('sort_order').notNull().default(0),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    typeNormalizedUnique: uniqueIndex('catalog_attribute_values_type_normalized_unique').on(
      table.attribute_type_id,
      table.value_normalized,
    ),
    typeIdx: index('catalog_attribute_values_type_idx').on(table.attribute_type_id),
  }),
);

export type CatalogAttributeTypeRow = typeof catalogAttributeTypesTable.$inferSelect;
export type NewCatalogAttributeTypeRow = typeof catalogAttributeTypesTable.$inferInsert;
export type CatalogAttributeValueRow = typeof catalogAttributeValuesTable.$inferSelect;
export type NewCatalogAttributeValueRow = typeof catalogAttributeValuesTable.$inferInsert;
