import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  mediaAssetsTable,
  type MediaAssetRow,
  type MediaDeleteReason,
  type NewMediaAssetRow,
} from '../schemas/media-assets.schema.js';

type Executor = Pick<typeof db, 'select' | 'update'>;

export async function insert(data: NewMediaAssetRow): Promise<MediaAssetRow> {
  const rows = await db.insert(mediaAssetsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function findById(id: number): Promise<MediaAssetRow | null> {
  const rows = await db.select().from(mediaAssetsTable).where(eq(mediaAssetsTable.id, id));
  return rows[0] ?? null;
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

/**
 * Moves a `pending` document on. Guarded by the status: two `complete` calls
 * racing each other (a retried request) update the row once, and the loser
 * reads the winner's result.
 */
export async function settlePending(
  id: number,
  patch: Partial<
    Pick<
      NewMediaAssetRow,
      'status' | 'document_type' | 'mime_type' | 'original_bytes' | 'expires_at'
    >
  >,
): Promise<MediaAssetRow | null> {
  const rows = await db
    .update(mediaAssetsTable)
    .set(patch)
    .where(and(eq(mediaAssetsTable.id, id), eq(mediaAssetsTable.status, 'pending')))
    .returning();
  return rows[0] ?? null;
}

/** Live documents only — a deleted file's deadline no longer means anything. */
export async function setExpiry(ids: number[], at: Date | null): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(mediaAssetsTable)
    .set({ expires_at: at })
    .where(
      and(
        inArray(mediaAssetsTable.id, ids),
        eq(mediaAssetsTable.kind, 'document'),
        inArray(mediaAssetsTable.status, ['pending', 'ready']),
      ),
    );
}

/** Oldest deadline first, so a backlog drains in the order it was promised. */
export async function findExpired(
  executor: Executor,
  now: Date,
  limit: number,
): Promise<MediaAssetRow[]> {
  return executor
    .select()
    .from(mediaAssetsTable)
    .where(
      and(
        inArray(mediaAssetsTable.status, ['pending', 'ready']),
        lt(mediaAssetsTable.expires_at, now),
      ),
    )
    .orderBy(asc(mediaAssetsTable.expires_at))
    .limit(limit);
}

export async function markDeleted(
  executor: Executor,
  id: number,
  reason: MediaDeleteReason,
  at: Date,
): Promise<void> {
  await executor
    .update(mediaAssetsTable)
    .set({ status: 'deleted', deleted_at: at, delete_reason: reason, expires_at: null })
    .where(eq(mediaAssetsTable.id, id));
}

/**
 * Session-free advisory lock for the duration of the surrounding transaction.
 * `false` = another machine holds it right now — skip this round.
 */
export async function tryTransactionLock(
  executor: Pick<typeof db, 'execute'>,
  name: string,
): Promise<boolean> {
  const result = await executor.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${name})) AS locked`,
  );
  return result.rows[0]?.locked === true;
}
