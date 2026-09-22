import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  serial,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { mediaAssetsTable } from '../../../core/media/schemas/media-assets.schema.js';
import { catalogProductsTable } from './products.schema.js';

/**
 * A marketing grouping that cuts across the tree — «العودة للمدارس»,
 * «هدايا عيد الأم». It decides nothing about price, tax or attributes: that is
 * the category's job, which is why a product has one category and any number
 * of collections.
 *
 * «Best sellers» and «under X» are NOT collections: the first is computed from
 * sales, the second is a price filter. Stored by hand, both go stale unnoticed.
 */
export const catalogCollectionsTable = pgTable('catalog_collections', {
  id: serial('id').primaryKey(),
  name_ar: varchar('name_ar', { length: 120 }).notNull(),
  name_en: varchar('name_en', { length: 120 }),
  image_id: integer('image_id').references(() => mediaAssetsTable.id, { onDelete: 'set null' }),
  /** Optional window for seasonal collections; shown to customers only inside it. */
  starts_at: timestamp('starts_at', { withTimezone: true }),
  ends_at: timestamp('ends_at', { withTimezone: true }),
  is_active: boolean('is_active').notNull().default(true),
  sort_order: integer('sort_order').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const catalogCollectionProductsTable = pgTable(
  'catalog_collection_products',
  {
    collection_id: integer('collection_id')
      .notNull()
      .references(() => catalogCollectionsTable.id, { onDelete: 'cascade' }),
    product_id: integer('product_id')
      .notNull()
      .references(() => catalogProductsTable.id, { onDelete: 'cascade' }),
    sort_order: integer('sort_order').notNull().default(0),
  },
  (table) => ({ pk: primaryKey({ columns: [table.collection_id, table.product_id] }) }),
);

export type CatalogCollectionRow = typeof catalogCollectionsTable.$inferSelect;
export type NewCatalogCollectionRow = typeof catalogCollectionsTable.$inferInsert;
