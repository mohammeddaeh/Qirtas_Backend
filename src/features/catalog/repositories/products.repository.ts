import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import { likeTerm } from '../../../core/db/like-term.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import {
  catalogBarcodesTable,
  catalogInternalBarcodeSeq,
  catalogProductMediaTable,
  catalogProductsTable,
  catalogVariantAttributeValuesTable,
  catalogVariantUnitsTable,
  catalogVariantsTable,
  type BarcodeSource,
  type CatalogBarcodeRow,
  type CatalogProductMediaRow,
  type CatalogProductRow,
  type CatalogVariantRow,
  type CatalogVariantUnitRow,
  type CatalogVariantValueRow,
  type NewCatalogProductRow,
  type NewCatalogVariantRow,
} from '../schemas/products.schema.js';

/** `db` itself or an open transaction — every write below can join one. */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ProductsQuery {
  searchFolded?: string | undefined;
  /** A barcode or SKU typed into the search box: matched exactly, not as a substring. */
  exactCode?: string | undefined;
  categoryIds?: number[] | undefined;
  brandId?: number | undefined;
  status?: CatalogProductRow['status'] | undefined;
  kind?: CatalogProductRow['kind'] | undefined;
  archived: boolean;
}

export function findMany(
  params: PaginationParams,
  q: ProductsQuery,
): Promise<{ rows: CatalogProductRow[]; total: number }> {
  const p = catalogProductsTable;
  const conditions: SQL[] = [q.archived ? isNotNull(p.archived_at) : isNull(p.archived_at)];
  if (q.categoryIds)
    conditions.push(inArray(p.category_id, q.categoryIds.length ? q.categoryIds : [-1]));
  if (q.brandId !== undefined) conditions.push(eq(p.brand_id, q.brandId));
  if (q.status) conditions.push(eq(p.status, q.status));
  if (q.kind) conditions.push(eq(p.kind, q.kind));

  const search: SQL[] = [];
  if (q.searchFolded) search.push(ilike(p.search_text, likeTerm(q.searchFolded)));
  if (q.exactCode) {
    search.push(
      sql`${p.id} in (
        select ${catalogVariantsTable.product_id} from ${catalogVariantsTable}
        left join ${catalogVariantUnitsTable} on ${catalogVariantUnitsTable.variant_id} = ${catalogVariantsTable.id}
        left join ${catalogBarcodesTable} on ${catalogBarcodesTable.variant_unit_id} = ${catalogVariantUnitsTable.id}
        where ${catalogBarcodesTable.code} = ${q.exactCode} or upper(${catalogVariantsTable.sku}) = ${q.exactCode}
      )`,
    );
  }
  if (search.length > 0) conditions.push(or(...search)!);

  return findManyPaginated<CatalogProductRow>(p, params, {
    where: and(...conditions),
    orderBy: desc(p.created_at),
  });
}

export function findById(id: number): Promise<CatalogProductRow | undefined> {
  return findOneById<CatalogProductRow>(catalogProductsTable, catalogProductsTable.id, id);
}

export function findManyByIds(ids: number[]): Promise<CatalogProductRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return db.select().from(catalogProductsTable).where(inArray(catalogProductsTable.id, ids));
}

export function findVariantById(id: number): Promise<CatalogVariantRow | undefined> {
  return findOneById<CatalogVariantRow>(catalogVariantsTable, catalogVariantsTable.id, id);
}

export function findVariantsOfProducts(productIds: number[]): Promise<CatalogVariantRow[]> {
  if (productIds.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(catalogVariantsTable)
    .where(inArray(catalogVariantsTable.product_id, productIds))
    .orderBy(asc(catalogVariantsTable.sort_order), asc(catalogVariantsTable.id));
}

export function findValuesOfVariants(variantIds: number[]): Promise<CatalogVariantValueRow[]> {
  if (variantIds.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(catalogVariantAttributeValuesTable)
    .where(inArray(catalogVariantAttributeValuesTable.variant_id, variantIds));
}

export function findUnitsOfVariants(variantIds: number[]): Promise<CatalogVariantUnitRow[]> {
  if (variantIds.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(catalogVariantUnitsTable)
    .where(inArray(catalogVariantUnitsTable.variant_id, variantIds))
    .orderBy(asc(catalogVariantUnitsTable.factor));
}

export function findBarcodesOfUnits(variantUnitIds: number[]): Promise<CatalogBarcodeRow[]> {
  if (variantUnitIds.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(catalogBarcodesTable)
    .where(inArray(catalogBarcodesTable.variant_unit_id, variantUnitIds))
    .orderBy(asc(catalogBarcodesTable.id));
}

export function findMediaOfProducts(productIds: number[]): Promise<CatalogProductMediaRow[]> {
  if (productIds.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(catalogProductMediaTable)
    .where(inArray(catalogProductMediaTable.product_id, productIds))
    .orderBy(asc(catalogProductMediaTable.sort_order), asc(catalogProductMediaTable.id));
}

export function findBarcodeById(id: number): Promise<CatalogBarcodeRow | undefined> {
  return findOneById<CatalogBarcodeRow>(catalogBarcodesTable, catalogBarcodesTable.id, id);
}

export function findVariantUnitById(id: number): Promise<CatalogVariantUnitRow | undefined> {
  return findOneById<CatalogVariantUnitRow>(
    catalogVariantUnitsTable,
    catalogVariantUnitsTable.id,
    id,
  );
}

export function findBarcodesByCode(code: string): Promise<CatalogBarcodeRow[]> {
  return db
    .select()
    .from(catalogBarcodesTable)
    .where(eq(catalogBarcodesTable.code, code))
    .orderBy(asc(catalogBarcodesTable.id));
}

/** How many (variant, unit) rows share each of [codes] — `> 1` is an ambiguity. */
export async function countByCodes(codes: string[]): Promise<Map<string, number>> {
  if (codes.length === 0) return new Map();
  const rows = await db
    .select({ code: catalogBarcodesTable.code, n: count() })
    .from(catalogBarcodesTable)
    .where(inArray(catalogBarcodesTable.code, codes))
    .groupBy(catalogBarcodesTable.code);
  return new Map(rows.map((r) => [r.code, r.n]));
}

/** Codes printed on more than one (variant, unit) — the dashboard's "shared barcodes" signal. */
export async function findSharedCodes(limit: number): Promise<{ code: string; n: number }[]> {
  return db
    .select({ code: catalogBarcodesTable.code, n: count() })
    .from(catalogBarcodesTable)
    .groupBy(catalogBarcodesTable.code)
    .having(sql`count(*) > 1`)
    .orderBy(desc(count()), asc(catalogBarcodesTable.code))
    .limit(limit);
}

export async function nextInternalBarcodeNumber(ex: Executor = db): Promise<number> {
  const result = await ex.execute<{ n: string }>(
    sql`select nextval(${sql.raw(`'${catalogInternalBarcodeSeq.seqName}'`)}) as n`,
  );
  return Number(result.rows[0]!.n);
}

// ── Counts other catalog rules depend on ────────────────────────────────────

export async function countProductsInCategories(
  categoryIds: number[],
  liveOnly: boolean,
): Promise<number> {
  if (categoryIds.length === 0) return 0;
  const p = catalogProductsTable;
  const rows = await db
    .select({ n: count() })
    .from(p)
    .where(and(inArray(p.category_id, categoryIds), liveOnly ? isNull(p.archived_at) : undefined));
  return rows[0]?.n ?? 0;
}

export async function countProductsOfBrand(brandId: number): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(catalogProductsTable)
    .where(eq(catalogProductsTable.brand_id, brandId));
  return rows[0]?.n ?? 0;
}

export async function countVariantsUsingValues(valueIds: number[]): Promise<number> {
  if (valueIds.length === 0) return 0;
  const rows = await db
    .select({ n: count() })
    .from(catalogVariantAttributeValuesTable)
    .where(inArray(catalogVariantAttributeValuesTable.attribute_value_id, valueIds));
  return rows[0]?.n ?? 0;
}

/** Variants in [categoryIds] that use any of [typeIds] — what blocks removing an allowed attribute. */
export async function countVariantsUsingTypesInCategories(
  typeIds: number[],
  categoryIds: number[],
): Promise<number> {
  if (typeIds.length === 0 || categoryIds.length === 0) return 0;
  const rows = await db
    .select({ n: count() })
    .from(catalogVariantAttributeValuesTable)
    .innerJoin(
      catalogVariantsTable,
      eq(catalogVariantsTable.id, catalogVariantAttributeValuesTable.variant_id),
    )
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(
      and(
        inArray(catalogVariantAttributeValuesTable.attribute_type_id, typeIds),
        inArray(catalogProductsTable.category_id, categoryIds),
      ),
    );
  return rows[0]?.n ?? 0;
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface VariantWrite {
  sku: string | null;
  combinationKey: string;
  values: { typeId: number; valueId: number }[];
  baseUnitId: number;
  units: { unitId: number; factor: number; isBase: boolean; online: boolean; pos: boolean }[];
  barcodes: { code: string; unitId: number; source: BarcodeSource }[];
  imageIds: number[];
  sortOrder: number;
}

export async function insertProduct(
  ex: Executor,
  data: NewCatalogProductRow,
): Promise<CatalogProductRow> {
  const rows = await ex.insert(catalogProductsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function updateProduct(
  ex: Executor,
  id: number,
  data: Partial<NewCatalogProductRow>,
): Promise<CatalogProductRow | undefined> {
  const rows = await ex
    .update(catalogProductsTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(catalogProductsTable.id, id))
    .returning();
  return rows[0];
}

/**
 * Inserts one variant with its values, units, barcodes and images.
 *
 * A variant without an explicit SKU gets `QRT-<id>` — derived from its own id
 * after the insert, so it is unique without a second counter. The placeholder
 * it is inserted with never leaves the transaction.
 */
export async function insertVariant(
  ex: Executor,
  productId: number,
  v: VariantWrite,
): Promise<CatalogVariantRow> {
  const inserted = await ex
    .insert(catalogVariantsTable)
    .values({
      product_id: productId,
      sku: v.sku ?? `tmp-${crypto.randomUUID()}`.slice(0, 40),
      combination_key: v.combinationKey,
      base_unit_id: v.baseUnitId,
      sort_order: v.sortOrder,
    } satisfies NewCatalogVariantRow)
    .returning();
  let variant = inserted[0]!;
  if (v.sku === null) {
    const renamed = await ex
      .update(catalogVariantsTable)
      .set({ sku: `QRT-${String(variant.id).padStart(6, '0')}` })
      .where(eq(catalogVariantsTable.id, variant.id))
      .returning();
    variant = renamed[0]!;
  }

  if (v.values.length > 0) {
    await ex.insert(catalogVariantAttributeValuesTable).values(
      v.values.map((value) => ({
        variant_id: variant.id,
        attribute_type_id: value.typeId,
        attribute_value_id: value.valueId,
      })),
    );
  }
  await replaceVariantUnits(ex, variant.id, v.units);
  await insertBarcodes(ex, variant.id, v.barcodes);
  if (v.imageIds.length > 0) {
    await ex
      .insert(catalogProductMediaTable)
      .values(
        v.imageIds.map((media_id, i) => ({
          product_id: productId,
          variant_id: variant.id,
          media_id,
          sort_order: i,
        })),
      );
  }
  return variant;
}

export async function updateVariant(
  ex: Executor,
  id: number,
  data: Partial<NewCatalogVariantRow>,
): Promise<CatalogVariantRow | undefined> {
  const rows = await ex
    .update(catalogVariantsTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(catalogVariantsTable.id, id))
    .returning();
  return rows[0];
}

export async function replaceVariantValues(
  ex: Executor,
  variantId: number,
  values: { typeId: number; valueId: number }[],
): Promise<void> {
  await ex
    .delete(catalogVariantAttributeValuesTable)
    .where(eq(catalogVariantAttributeValuesTable.variant_id, variantId));
  if (values.length > 0) {
    await ex
      .insert(catalogVariantAttributeValuesTable)
      .values(
        values.map((v) => ({
          variant_id: variantId,
          attribute_type_id: v.typeId,
          attribute_value_id: v.valueId,
        })),
      );
  }
}

/**
 * Upserts the variant's units by `unit_id` and removes the ones not listed.
 * Rows are updated in place rather than recreated, so barcodes (which point at
 * the row) survive a change of factor or flags. The service refuses removing a
 * unit that still carries a barcode before this runs.
 */
export async function replaceVariantUnits(
  ex: Executor,
  variantId: number,
  units: VariantWrite['units'],
): Promise<void> {
  const existing = await ex
    .select()
    .from(catalogVariantUnitsTable)
    .where(eq(catalogVariantUnitsTable.variant_id, variantId));
  const keep = new Set(units.map((u) => u.unitId));
  const drop = existing.filter((row) => !keep.has(row.unit_id)).map((row) => row.id);
  if (drop.length > 0)
    await ex.delete(catalogVariantUnitsTable).where(inArray(catalogVariantUnitsTable.id, drop));

  for (const u of units) {
    const values = {
      factor: u.factor.toFixed(3),
      is_base: u.isBase,
      sellable_online: u.online,
      sellable_at_pos: u.pos,
    };
    const current = existing.find((row) => row.unit_id === u.unitId);
    if (current) {
      await ex
        .update(catalogVariantUnitsTable)
        .set(values)
        .where(eq(catalogVariantUnitsTable.id, current.id));
    } else {
      await ex
        .insert(catalogVariantUnitsTable)
        .values({ variant_id: variantId, unit_id: u.unitId, ...values });
    }
  }
}

export async function insertBarcodes(
  ex: Executor,
  variantId: number,
  barcodes: VariantWrite['barcodes'],
): Promise<CatalogBarcodeRow[]> {
  if (barcodes.length === 0) return [];
  const units = await ex
    .select()
    .from(catalogVariantUnitsTable)
    .where(eq(catalogVariantUnitsTable.variant_id, variantId));
  const rowByUnit = new Map(units.map((u) => [u.unit_id, u.id]));
  return ex
    .insert(catalogBarcodesTable)
    .values(
      barcodes.map((b) => ({
        code: b.code,
        variant_unit_id: rowByUnit.get(b.unitId)!,
        source: b.source,
      })),
    )
    .returning();
}

export async function deleteBarcode(id: number): Promise<void> {
  await db.delete(catalogBarcodesTable).where(eq(catalogBarcodesTable.id, id));
}

export async function replaceProductImages(
  ex: Executor,
  productId: number,
  imageIds: number[],
): Promise<void> {
  await ex
    .delete(catalogProductMediaTable)
    .where(
      and(
        eq(catalogProductMediaTable.product_id, productId),
        isNull(catalogProductMediaTable.variant_id),
      ),
    );
  if (imageIds.length > 0) {
    await ex
      .insert(catalogProductMediaTable)
      .values(imageIds.map((media_id, i) => ({ product_id: productId, media_id, sort_order: i })));
  }
}

export async function replaceVariantImages(
  ex: Executor,
  productId: number,
  variantId: number,
  imageIds: number[],
): Promise<void> {
  await ex
    .delete(catalogProductMediaTable)
    .where(eq(catalogProductMediaTable.variant_id, variantId));
  if (imageIds.length > 0) {
    await ex
      .insert(catalogProductMediaTable)
      .values(
        imageIds.map((media_id, i) => ({
          product_id: productId,
          variant_id: variantId,
          media_id,
          sort_order: i,
        })),
      );
  }
}

export async function hardDeleteVariant(ex: Executor, id: number): Promise<void> {
  await ex.delete(catalogVariantsTable).where(eq(catalogVariantsTable.id, id));
}

/** Variants first: their FK to the product is RESTRICT on purpose, so a product can never lose variants by accident. */
export async function hardDeleteProduct(ex: Executor, id: number): Promise<void> {
  await ex.delete(catalogVariantsTable).where(eq(catalogVariantsTable.product_id, id));
  await ex.delete(catalogProductsTable).where(eq(catalogProductsTable.id, id));
}
