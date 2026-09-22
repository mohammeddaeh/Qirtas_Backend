import { and, asc, eq, ilike, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import { likeTerm } from '../../../core/db/like-term.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import {
  catalogBrandsTable,
  type CatalogBrandRow,
  type NewCatalogBrandRow,
} from '../schemas/brands.schema.js';
import type { BrandsFilterQuery } from '../dtos/brands.dto.js';

export function findMany(
  params: PaginationParams,
  filter: BrandsFilterQuery,
): Promise<{ rows: CatalogBrandRow[]; total: number }> {
  const conditions: SQL[] = [
    filter.archived
      ? isNotNull(catalogBrandsTable.archived_at)
      : isNull(catalogBrandsTable.archived_at),
  ];
  // Searches the folded column with a folded term, so «فابر» finds «فابر-كاستل»
  // however either was typed.
  if (filter.search) {
    conditions.push(
      ilike(catalogBrandsTable.name_normalized, likeTerm(normalizeArabic(filter.search))),
    );
  }
  return findManyPaginated<CatalogBrandRow>(catalogBrandsTable, params, {
    where: and(...conditions),
    orderBy: asc(catalogBrandsTable.name),
  });
}

export function findById(id: number): Promise<CatalogBrandRow | undefined> {
  return findOneById<CatalogBrandRow>(catalogBrandsTable, catalogBrandsTable.id, id);
}

export async function findByNormalizedName(
  normalized: string,
): Promise<CatalogBrandRow | undefined> {
  const rows = await db
    .select()
    .from(catalogBrandsTable)
    .where(eq(catalogBrandsTable.name_normalized, normalized))
    .limit(1);
  return rows[0];
}

export async function insert(data: NewCatalogBrandRow): Promise<CatalogBrandRow> {
  const rows = await db.insert(catalogBrandsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function update(
  id: number,
  data: Partial<NewCatalogBrandRow>,
): Promise<CatalogBrandRow | undefined> {
  const rows = await db
    .update(catalogBrandsTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(catalogBrandsTable.id, id))
    .returning();
  return rows[0];
}

export async function hardDelete(id: number): Promise<void> {
  await db.delete(catalogBrandsTable).where(eq(catalogBrandsTable.id, id));
}
