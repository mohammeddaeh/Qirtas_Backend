import { asc, eq } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findOneById } from '../../../core/db/crud-helpers.js';
import {
  catalogCategoriesTable,
  catalogCategoryAttributesTable,
  type CatalogCategoryAttributeRow,
  type CatalogCategoryRow,
  type NewCatalogCategoryRow,
} from '../schemas/categories.schema.js';
import { CATEGORY_PATHS_CACHE, clearCache } from '../../../core/db/ttl-cache.js';
import { PRICING_CONTEXT_CACHE } from './pricing.repository.js';

/**
 * The whole tree, archived rows included — structural rules (depth, cycles,
 * sibling names) must see every row, and the service filters for display.
 */
export function findAll(): Promise<CatalogCategoryRow[]> {
  return db
    .select()
    .from(catalogCategoriesTable)
    .orderBy(asc(catalogCategoriesTable.sort_order), asc(catalogCategoriesTable.id));
}

export function findById(id: number): Promise<CatalogCategoryRow | undefined> {
  return findOneById<CatalogCategoryRow>(catalogCategoriesTable, catalogCategoriesTable.id, id);
}

export function findAllAttributeLinks(): Promise<CatalogCategoryAttributeRow[]> {
  return db.select().from(catalogCategoryAttributesTable);
}

export async function insert(data: NewCatalogCategoryRow): Promise<CatalogCategoryRow> {
  const rows = await db.insert(catalogCategoriesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  clearCache(PRICING_CONTEXT_CACHE);
  clearCache(CATEGORY_PATHS_CACHE);
  return row;
}

export async function update(
  id: number,
  data: Partial<NewCatalogCategoryRow>,
): Promise<CatalogCategoryRow | undefined> {
  const rows = await db
    .update(catalogCategoriesTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(catalogCategoriesTable.id, id))
    .returning();
  clearCache(PRICING_CONTEXT_CACHE);
  clearCache(CATEGORY_PATHS_CACHE);
  return rows[0];
}

/**
 * Moves a node and rewrites every descendant's `level` in one transaction —
 * a half-applied move would leave levels that contradict the parent chain.
 */
export async function moveWithLevels(
  id: number,
  data: Partial<NewCatalogCategoryRow>,
  levels: ReadonlyMap<number, number>,
): Promise<CatalogCategoryRow | undefined> {
  const moved = await db.transaction(async (tx) => {
    for (const [nodeId, level] of levels) {
      if (nodeId === id) continue;
      await tx
        .update(catalogCategoriesTable)
        .set({ level, updated_at: new Date() })
        .where(eq(catalogCategoriesTable.id, nodeId));
    }
    const rows = await tx
      .update(catalogCategoriesTable)
      .set({ ...data, level: levels.get(id), updated_at: new Date() })
      .where(eq(catalogCategoriesTable.id, id))
      .returning();
    return rows[0];
  });
  clearCache(PRICING_CONTEXT_CACHE);
  clearCache(CATEGORY_PATHS_CACHE);
  return moved;
}

/** Replaces a category's own allowed attributes. Inherited ones are not rows here. */
export async function replaceAttributeLinks(categoryId: number, typeIds: number[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(catalogCategoryAttributesTable)
      .where(eq(catalogCategoryAttributesTable.category_id, categoryId));
    if (typeIds.length > 0) {
      await tx
        .insert(catalogCategoryAttributesTable)
        .values(
          typeIds.map((attribute_type_id) => ({ category_id: categoryId, attribute_type_id })),
        );
    }
  });
}

export async function hardDelete(id: number): Promise<void> {
  await db.delete(catalogCategoriesTable).where(eq(catalogCategoriesTable.id, id));
  clearCache(PRICING_CONTEXT_CACHE);
  clearCache(CATEGORY_PATHS_CACHE);
}
