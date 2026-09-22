import { asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findOneById } from '../../../core/db/crud-helpers.js';
import {
  catalogCollectionProductsTable,
  catalogCollectionsTable,
  type CatalogCollectionRow,
  type NewCatalogCollectionRow,
} from '../schemas/collections.schema.js';

/** Unpaginated: a shop runs a handful of collections at a time. */
export function findAll(): Promise<CatalogCollectionRow[]> {
  return db
    .select()
    .from(catalogCollectionsTable)
    .orderBy(asc(catalogCollectionsTable.sort_order), asc(catalogCollectionsTable.id));
}

export function findById(id: number): Promise<CatalogCollectionRow | undefined> {
  return findOneById<CatalogCollectionRow>(catalogCollectionsTable, catalogCollectionsTable.id, id);
}

export async function productCounts(ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: catalogCollectionProductsTable.collection_id, n: count() })
    .from(catalogCollectionProductsTable)
    .where(inArray(catalogCollectionProductsTable.collection_id, ids))
    .groupBy(catalogCollectionProductsTable.collection_id);
  return new Map(rows.map((r) => [r.id, r.n]));
}

export async function productIdsOf(id: number): Promise<number[]> {
  const rows = await db
    .select({ product_id: catalogCollectionProductsTable.product_id })
    .from(catalogCollectionProductsTable)
    .where(eq(catalogCollectionProductsTable.collection_id, id))
    .orderBy(asc(catalogCollectionProductsTable.sort_order));
  return rows.map((r) => r.product_id);
}

export async function insert(data: NewCatalogCollectionRow): Promise<CatalogCollectionRow> {
  const rows = await db.insert(catalogCollectionsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function update(
  id: number,
  data: Partial<NewCatalogCollectionRow>,
): Promise<CatalogCollectionRow | undefined> {
  const rows = await db
    .update(catalogCollectionsTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(catalogCollectionsTable.id, id))
    .returning();
  return rows[0];
}

export async function replaceProducts(id: number, productIds: number[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(catalogCollectionProductsTable)
      .where(eq(catalogCollectionProductsTable.collection_id, id));
    if (productIds.length > 0) {
      await tx
        .insert(catalogCollectionProductsTable)
        .values(
          productIds.map((product_id, i) => ({ collection_id: id, product_id, sort_order: i })),
        );
    }
  });
}

export async function hardDelete(id: number): Promise<void> {
  await db.delete(catalogCollectionsTable).where(eq(catalogCollectionsTable.id, id));
}
