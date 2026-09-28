import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { usersTable } from '../../../features/identity/schemas/users.schema.js';
import { customersTable } from '../../../features/customers/schemas/customers.schema.js';
import type { StorageZone } from '../ports/storage-driver.js';
import type { DocumentType } from '../document-types.js';

/**
 * One uploaded file and everything the server made from it.
 *
 * Owned by `core/media/`, not by a feature, because several features point at
 * it — catalog images now, print documents and customization artwork later —
 * and a feature may not import another feature. **One table for every file**:
 * a second one for documents would be a second place a file's life is written,
 * and the two disagree the first time one is updated without the other.
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

export type MediaAssetKind = 'image' | 'document';

/**
 * Only states the server can **prove**. There is no `uploading`: the upload
 * goes straight to the store, so the server cannot know it started, stalled or
 * is half done — a state it cannot keep true would be a lie on the screen.
 *
 * - `pending`  — reserved; the client holds an upload link. Nothing verified.
 * - `ready`    — the bytes arrived, are the declared size and an allowed type.
 * - `rejected` — the bytes arrived and are not an allowed type. Object deleted.
 * - `deleted`  — the sweeper removed the object; the row stays as history.
 *
 * Images are born `ready` (they are processed inside the request).
 */
export type MediaAssetStatus = 'pending' | 'ready' | 'rejected' | 'deleted';

export type MediaDeleteReason = 'upload_abandoned' | 'retention_expired';

export const mediaAssetsTable = pgTable(
  'media_assets',
  {
    id: serial('id').primaryKey(),
    zone: varchar('zone', { length: 10 }).$type<StorageZone>().notNull(),
    kind: varchar('kind', { length: 20 }).$type<MediaAssetKind>().notNull(),
    /**
     * Images: shared prefix of every variant key, e.g. `img/2026/09/<uuid>`.
     * Documents: the one object's full key, `doc/2026/09/<uuid>.bin`. Unique.
     */
    key_base: varchar('key_base', { length: 200 }).notNull().unique(),
    original_filename: varchar('original_filename', { length: 255 }),
    /** Documents: the declared size while `pending`, the stored size once `ready`. */
    original_bytes: integer('original_bytes').notNull(),
    /** Images only — a document has no dimensions. */
    width: integer('width'),
    height: integer('height'),
    variants: jsonb('variants').$type<MediaVariantRecord[]>().notNull(),
    status: varchar('status', { length: 12 }).$type<MediaAssetStatus>().notNull().default('ready'),
    /** Documents: what **the bytes** are (`document-types.ts`) — null until verified. */
    document_type: varchar('document_type', { length: 10 }).$type<DocumentType>(),
    mime_type: varchar('mime_type', { length: 120 }),
    uploaded_by_user_id: integer('uploaded_by_user_id').references(() => usersTable.id, {
      onDelete: 'set null',
    }),
    /**
     * A customer's upload. A second column, not a polymorphic id: staff and
     * customers are separate tables (as in `customer_activity_log`), and a
     * foreign key is what keeps a deleted account from leaving a dangling id.
     */
    uploaded_by_customer_id: integer('uploaded_by_customer_id').references(
      () => customersTable.id,
      { onDelete: 'set null' },
    ),
    /**
     * Set when something (a product, a category) starts using the file.
     *
     * Uploading happens before the form is saved, so an abandoned form leaves an
     * unattached upload behind. A null here older than a day is an orphan that a
     * cleanup job may delete.
     */
    attached_at: timestamp('attached_at', { withTimezone: true }),
    /**
     * When the sweeper removes the object (`document-sweeper.ts`). Null = kept.
     * Pending: the upload deadline. Ready: set by the owning feature (a print
     * job's retention) — `ready` starts with a default so a file nobody claims
     * does not stay forever.
     */
    expires_at: timestamp('expires_at', { withTimezone: true }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
    delete_reason: varchar('delete_reason', { length: 30 }).$type<MediaDeleteReason>(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The sweeper's only query: live documents past their deadline.
    index('media_assets_expiry_idx')
      .on(table.expires_at)
      .where(sql`${table.status} IN ('pending', 'ready')`),
    check(
      'media_assets_one_uploader',
      sql`${table.uploaded_by_user_id} IS NULL OR ${table.uploaded_by_customer_id} IS NULL`,
    ),
  ],
);

export type MediaAssetRow = typeof mediaAssetsTable.$inferSelect;
export type NewMediaAssetRow = typeof mediaAssetsTable.$inferInsert;
