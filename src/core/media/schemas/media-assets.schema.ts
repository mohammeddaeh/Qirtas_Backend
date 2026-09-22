import { integer, jsonb, pgTable, serial, timestamp, varchar } from 'drizzle-orm/pg-core';
import { usersTable } from '../../../features/identity/schemas/users.schema.js';
import type { StorageZone } from '../ports/storage-driver.js';

/**
 * One uploaded file and everything the server made from it.
 *
 * Owned by `core/media/`, not by a feature, because several features point at
 * it — catalog images now, print documents and customization artwork later —
 * and a feature may not import another feature.
 *
 * The row records **keys, not URLs**. A URL depends on where the file is served
 * from today; a stored URL would be wrong the day storage moves.
 */
export interface MediaVariantRecord {
  name: string;
  key: string;
  width: number;
  height: number;
  bytes: number;
}

export const mediaAssetsTable = pgTable('media_assets', {
  id: serial('id').primaryKey(),
  zone: varchar('zone', { length: 10 }).$type<StorageZone>().notNull(),
  /** `image` today; `document` arrives with the printing module. */
  kind: varchar('kind', { length: 20 }).$type<'image'>().notNull(),
  /** Shared prefix of every variant key, e.g. `img/2026/09/<uuid>`. Unique. */
  key_base: varchar('key_base', { length: 200 }).notNull().unique(),
  original_filename: varchar('original_filename', { length: 255 }),
  original_bytes: integer('original_bytes').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  variants: jsonb('variants').$type<MediaVariantRecord[]>().notNull(),
  uploaded_by_user_id: integer('uploaded_by_user_id').references(() => usersTable.id, {
    onDelete: 'set null',
  }),
  /**
   * Set when something (a product, a category) starts using the file.
   *
   * Uploading happens before the form is saved, so an abandoned form leaves an
   * unattached upload behind. A null here older than a day is an orphan that a
   * cleanup job may delete — the job itself arrives with the catalog screens,
   * the column now so no backfill is ever needed.
   */
  attached_at: timestamp('attached_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MediaAssetRow = typeof mediaAssetsTable.$inferSelect;
export type NewMediaAssetRow = typeof mediaAssetsTable.$inferInsert;
