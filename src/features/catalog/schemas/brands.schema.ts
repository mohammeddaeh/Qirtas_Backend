import { integer, pgTable, serial, timestamp, varchar } from 'drizzle-orm/pg-core';
import { mediaAssetsTable } from '../../../core/media/schemas/media-assets.schema.js';

/** Optional on a product. Branch drafts reveal the brands actually sold locally. */
export const catalogBrandsTable = pgTable('catalog_brands', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  /** Folded `name` — unique, so «Faber-Castell» and «faber-castell» are one brand. */
  name_normalized: varchar('name_normalized', { length: 120 }).notNull().unique(),
  logo_image_id: integer('logo_image_id').references(() => mediaAssetsTable.id, {
    onDelete: 'set null',
  }),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CatalogBrandRow = typeof catalogBrandsTable.$inferSelect;
export type NewCatalogBrandRow = typeof catalogBrandsTable.$inferInsert;
