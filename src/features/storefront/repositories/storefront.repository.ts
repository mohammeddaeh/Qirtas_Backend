import { and, asc, count, eq, gt, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated } from '../../../core/db/crud-helpers.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { catalogBrandsTable } from '../../catalog/schemas/brands.schema.js';
import { catalogCategoriesTable } from '../../catalog/schemas/categories.schema.js';
import {
  catalogCollectionProductsTable,
  catalogCollectionsTable,
} from '../../catalog/schemas/collections.schema.js';
import {
  catalogBranchListingsTable,
  catalogBranchPricesTable,
  catalogVariantPricesTable,
} from '../../catalog/schemas/pricing.schema.js';
import {
  catalogProductMediaTable,
  catalogProductsTable,
  catalogVariantAttributeValuesTable,
  catalogVariantUnitsTable,
  catalogVariantsTable,
  type CatalogProductRow,
} from '../../catalog/schemas/products.schema.js';
import { catalogUnitsTable } from '../../catalog/schemas/units.schema.js';
import { catalogAttributeValuesTable } from '../../catalog/schemas/attributes.schema.js';
import { stockBalancesTable } from '../../inventory/schemas/stock.schema.js';
import { customersTable } from '../../customers/schemas/customers.schema.js';

/**
 * What the shop shows a customer — read-only, and **schemas only**.
 *
 * The storefront owns no table of its own: it answers from the catalog's rows,
 * the ledger's balances and the organisation's branches. Reading another
 * feature's *tables* is allowed; reading its service or repository is not
 * (`features/CLAUDE.md`), which is why the price never comes from here — it
 * comes from `core/pricing`'s port.
 */

const p = catalogProductsTable;
const v = catalogVariantsTable;

/** Live, published, sellable — the only rows a customer may be shown at all. */
function publishedProduct(): SQL[] {
  return [
    isNull(p.archived_at),
    eq(p.status, 'active'),
    eq(p.is_sellable, true),
    // A branch draft holds stock and has no agreed name yet (§٢): it is
    // received against and never sold.
    eq(p.is_branch_draft, false),
  ];
}

export interface StorefrontProductsQuery {
  /** The branch the customer is shopping at — every row is judged against it. */
  branchId: number;
  searchFolded?: string | undefined;
  categoryIds?: number[] | undefined;
  collectionId?: number | undefined;
}

/**
 * Sellable **here**: at least one active variant that somebody priced and
 * this branch has not withdrawn.
 *
 * It is done in SQL and not only in the service because the page and its
 * count must agree: dropping unsellable rows after paging returns an empty
 * page under `total: 9`, and an empty page reads as a broken shop rather
 * than as a catalogue nobody has priced yet. The service still has the last
 * word — a dollar price with no exchange rate is unpriced too, and no SQL
 * here knows that.
 */
function sellableAt(branchId: number): SQL {
  return sql`exists (
    select 1 from ${v}
    where ${v.product_id} = ${p.id} and ${v.status} = 'active'
      and (
        exists (select 1 from ${catalogVariantPricesTable} cp where cp.variant_id = ${v.id})
        or exists (
          select 1 from ${catalogBranchPricesTable} bp
          where bp.variant_id = ${v.id} and bp.branch_id = ${branchId}
        )
      )
      and not exists (
        select 1 from ${catalogBranchListingsTable} bl
        where bl.variant_id = ${v.id} and bl.branch_id = ${branchId} and bl.is_listed = false
      )
  )`;
}

export function findProducts(
  params: PaginationParams,
  q: StorefrontProductsQuery,
): Promise<{ rows: CatalogProductRow[]; total: number }> {
  const conditions: SQL[] = [...publishedProduct(), sellableAt(q.branchId)];
  if (q.categoryIds) conditions.push(inArray(p.category_id, q.categoryIds.length ? q.categoryIds : [-1]));
  if (q.searchFolded) conditions.push(ilike(p.search_text, `%${q.searchFolded}%`));
  if (q.collectionId !== undefined) {
    conditions.push(
      sql`${p.id} in (
        select ${catalogCollectionProductsTable.product_id} from ${catalogCollectionProductsTable}
        where ${catalogCollectionProductsTable.collection_id} = ${q.collectionId}
      )`,
    );
  }
  return findManyPaginated<CatalogProductRow>(p, params, {
    where: and(...conditions),
    // Newest first, like every other list in this API — and stable, so the
    // second page is not the first page again.
    orderBy: sql`${p.created_at} desc, ${p.id} desc`,
  });
}

export async function findPublishedProduct(id: number): Promise<CatalogProductRow | undefined> {
  const [row] = await db
    .select()
    .from(p)
    .where(and(eq(p.id, id), ...publishedProduct()));
  return row;
}

export function findActiveVariants(productIds: number[]) {
  if (productIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      id: v.id,
      product_id: v.product_id,
      sku: v.sku,
      base_unit_id: v.base_unit_id,
    })
    .from(v)
    .where(and(inArray(v.product_id, productIds), eq(v.status, 'active')))
    .orderBy(asc(v.sort_order), asc(v.id));
}

/** «أزرق · 0.5» — the words that tell one variant from another. */
export async function findVariantLabels(variantIds: number[]): Promise<Map<number, string>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db
    .select({ variant_id: catalogVariantAttributeValuesTable.variant_id, value_ar: catalogAttributeValuesTable.value_ar })
    .from(catalogVariantAttributeValuesTable)
    .innerJoin(
      catalogAttributeValuesTable,
      eq(catalogAttributeValuesTable.id, catalogVariantAttributeValuesTable.attribute_value_id),
    )
    .where(inArray(catalogVariantAttributeValuesTable.variant_id, variantIds));
  const parts = new Map<number, string[]>();
  for (const row of rows) parts.set(row.variant_id, [...(parts.get(row.variant_id) ?? []), row.value_ar]);
  return new Map([...parts].map(([id, words]) => [id, words.join(' · ')]));
}

/** The units a customer may buy one in — online only (§٩). */
export function findSellableUnits(variantIds: number[]) {
  if (variantIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      variant_id: catalogVariantUnitsTable.variant_id,
      unit_id: catalogVariantUnitsTable.unit_id,
      name_ar: catalogUnitsTable.name_ar,
      factor: catalogVariantUnitsTable.factor,
      is_base: catalogVariantUnitsTable.is_base,
    })
    .from(catalogVariantUnitsTable)
    .innerJoin(catalogUnitsTable, eq(catalogUnitsTable.id, catalogVariantUnitsTable.unit_id))
    .where(
      and(
        inArray(catalogVariantUnitsTable.variant_id, variantIds),
        eq(catalogVariantUnitsTable.sellable_online, true),
      ),
    )
    .orderBy(asc(catalogVariantUnitsTable.factor));
}

export function findImageLinks(productIds: number[]) {
  if (productIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      product_id: catalogProductMediaTable.product_id,
      variant_id: catalogProductMediaTable.variant_id,
      media_id: catalogProductMediaTable.media_id,
    })
    .from(catalogProductMediaTable)
    .where(inArray(catalogProductMediaTable.product_id, productIds))
    .orderBy(asc(catalogProductMediaTable.sort_order), asc(catalogProductMediaTable.id));
}

export function findBrandNames(brandIds: number[]) {
  if (brandIds.length === 0) return Promise.resolve([]);
  return db
    .select({ id: catalogBrandsTable.id, name: catalogBrandsTable.name })
    .from(catalogBrandsTable)
    .where(inArray(catalogBrandsTable.id, brandIds));
}

/** What this branch holds. `available` is `on_hand − reserved`: goods promised
 *  to a confirmed order are not on the shelf for the next customer. */
export function findStockAt(branchId: number, variantIds: number[]) {
  if (variantIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      variant_id: stockBalancesTable.variant_id,
      on_hand: stockBalancesTable.on_hand,
      reserved: stockBalancesTable.reserved,
    })
    .from(stockBalancesTable)
    .where(and(eq(stockBalancesTable.branch_id, branchId), inArray(stockBalancesTable.variant_id, variantIds)));
}

/**
 * Other **live** branches holding any of these variants.
 *
 * A closed branch is left out: sending a customer to a shut door is worse than
 * saying «نفد حالياً», which at least offers «أعلمني».
 */
export function findStockElsewhere(branchId: number, variantIds: number[]) {
  if (variantIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      variant_id: stockBalancesTable.variant_id,
      branch_id: stockBalancesTable.branch_id,
      branch_name: branchesTable.name,
      latitude: branchesTable.latitude,
      longitude: branchesTable.longitude,
      on_hand: stockBalancesTable.on_hand,
      reserved: stockBalancesTable.reserved,
    })
    .from(stockBalancesTable)
    .innerJoin(branchesTable, eq(branchesTable.id, stockBalancesTable.branch_id))
    .where(
      and(
        inArray(stockBalancesTable.variant_id, variantIds),
        ne(stockBalancesTable.branch_id, branchId),
        eq(branchesTable.status, 'active'),
        isNull(branchesTable.archived_at),
        gt(stockBalancesTable.on_hand, '0'),
      ),
    );
}

/**
 * ما يصلح بديلاً: أصناف **من نفس التصنيف** موجودة فعلاً على رفّ هذا الفرع.
 *
 * الاختيار النهائي بالخدمة (القرب بالسعر يحتاج السعر، والسعر يأتي من منفذ
 * `core/pricing`)، وهذا يضيّق المرشّحين لما يمكن تسليمه اليوم: اقتراحٌ نافدٌ
 * هو نفس الطريق المسدود الذي جاء الزبون منه.
 */
/** صنفٌ واحد يُباع فعلاً — حارس «أعلمني»: طلبٌ على ما لا يُباع لا يقول شيئاً. */
export async function findSellableVariant(variantId: number) {
  const [row] = await db
    .select({ id: v.id, product_id: v.product_id })
    .from(v)
    .innerJoin(p, eq(p.id, v.product_id))
    .where(and(eq(v.id, variantId), eq(v.status, 'active'), ...publishedProduct()));
  return row;
}

export function findInStockSiblings(categoryIds: number[], branchId: number, excludeProductId: number, limit: number) {
  if (categoryIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      product_id: p.id,
      name_ar: p.name_ar,
      name_en: p.name_en,
      brand_id: p.brand_id,
      category_id: p.category_id,
      variant_id: v.id,
      on_hand: stockBalancesTable.on_hand,
      reserved: stockBalancesTable.reserved,
    })
    .from(v)
    .innerJoin(p, eq(p.id, v.product_id))
    .innerJoin(
      stockBalancesTable,
      and(eq(stockBalancesTable.variant_id, v.id), eq(stockBalancesTable.branch_id, branchId)),
    )
    .where(
      and(
        ...publishedProduct(),
        eq(v.status, 'active'),
        inArray(p.category_id, categoryIds),
        ne(p.id, excludeProductId),
        gt(stockBalancesTable.on_hand, '0'),
      ),
    )
    .limit(limit);
}

export function findBranch(branchId: number) {
  return db
    .select({
      id: branchesTable.id,
      name: branchesTable.name,
      status: branchesTable.status,
      latitude: branchesTable.latitude,
      longitude: branchesTable.longitude,
      archived_at: branchesTable.archived_at,
    })
    .from(branchesTable)
    .where(eq(branchesTable.id, branchId))
    .then((rows) => rows[0]);
}

export function findActiveCategories() {
  return db
    .select({
      id: catalogCategoriesTable.id,
      parent_id: catalogCategoriesTable.parent_id,
      level: catalogCategoriesTable.level,
      name_ar: catalogCategoriesTable.name_ar,
      name_en: catalogCategoriesTable.name_en,
    })
    .from(catalogCategoriesTable)
    .where(and(eq(catalogCategoriesTable.is_active, true), isNull(catalogCategoriesTable.archived_at)))
    .orderBy(asc(catalogCategoriesTable.sort_order), asc(catalogCategoriesTable.id));
}

/** Live products per category — the number that tells a dead end from a shelf. */
export async function countProductsPerCategory(): Promise<Map<number, number>> {
  const rows = await db
    .select({ category_id: p.category_id, n: count() })
    .from(p)
    .where(and(...publishedProduct()))
    .groupBy(p.category_id);
  return new Map(rows.map((row) => [row.category_id, Number(row.n)]));
}

/**
 * Shelves a customer may see **right now**: switched on, and inside their
 * window. A shelf whose season ended is not «نشطة» — it simply is not there
 * (`collection_window_test` pins the same rule on the client).
 */
export async function findVisibleCollections(now: Date) {
  const c = catalogCollectionsTable;
  return db
    .select({
      id: c.id,
      name_ar: c.name_ar,
      name_en: c.name_en,
      image_id: c.image_id,
      sort_order: c.sort_order,
    })
    .from(c)
    .where(
      and(
        eq(c.is_active, true),
        or(isNull(c.starts_at), sql`${c.starts_at} <= ${now}`)!,
        or(isNull(c.ends_at), sql`${c.ends_at} > ${now}`)!,
      ),
    )
    .orderBy(asc(c.sort_order), asc(c.id));
}

export async function countProductsPerCollection(collectionIds: number[]): Promise<Map<number, number>> {
  if (collectionIds.length === 0) return new Map();
  const rows = await db
    .select({ collection_id: catalogCollectionProductsTable.collection_id, n: count() })
    .from(catalogCollectionProductsTable)
    .innerJoin(p, eq(p.id, catalogCollectionProductsTable.product_id))
    .where(
      and(inArray(catalogCollectionProductsTable.collection_id, collectionIds), ...publishedProduct()),
    )
    .groupBy(catalogCollectionProductsTable.collection_id);
  return new Map(rows.map((row) => [row.collection_id, Number(row.n)]));
}

/**
 * Is this customer approved to buy at wholesale?
 *
 * Read from the row, not from the session: an approval granted or withdrawn
 * while somebody is browsing must take effect on the next screen, and a flag
 * cached on a session would keep a withdrawn discount alive for days.
 */
export async function isWholesaleCustomer(customerId: number): Promise<boolean> {
  const [row] = await db
    .select({ customer_type: customersTable.customer_type })
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  return row?.customer_type === 'wholesale';
}
