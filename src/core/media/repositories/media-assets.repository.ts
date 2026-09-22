import { and, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  mediaAssetsTable,
  type MediaAssetRow,
  type NewMediaAssetRow,
} from '../schemas/media-assets.schema.js';

export async function insert(data: NewMediaAssetRow): Promise<MediaAssetRow> {
  const rows = await db.insert(mediaAssetsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function findManyByIds(ids: number[]): Promise<MediaAssetRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(mediaAssetsTable).where(inArray(mediaAssetsTable.id, ids));
}

/** Idempotent: an asset already attached keeps its original timestamp. */
export async function markAttached(ids: number[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(mediaAssetsTable)
    .set({ attached_at: at })
    .where(and(inArray(mediaAssetsTable.id, ids), isNull(mediaAssetsTable.attached_at)));
}
