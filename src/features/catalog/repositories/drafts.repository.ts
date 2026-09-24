import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { stockBalancesTable } from '../../inventory/schemas/stock.schema.js';
import { catalogCategoriesTable } from '../schemas/categories.schema.js';
import {
  catalogBarcodesTable,
  catalogProductsTable,
  catalogVariantUnitsTable,
  catalogVariantsTable,
} from '../schemas/products.schema.js';
import { catalogUnitsTable } from '../schemas/units.schema.js';

/**
 * Branch drafts read as a list of their own, even though they are ordinary
 * product rows: what makes one a draft is `is_branch_draft`, and what a
 * reviewer needs beside it — which branch, how long it has waited, what it
 * scans as, how much stock it already holds — is a join, not a new table.
 *
 * The stock join reads `stock_balances` directly. A **schema** read of
 * another feature's table (like `dashboard` does), never a call into its
 * service: the balance is a fact, and asking the inventory module for it
 * would make the catalog depend on that module existing.
 */

export interface DraftRow {
  id: number;
  name_ar: string;
  name_en: string | null;
  sku: string;
  variant_id: number;
  category_id: number;
  category_name_ar: string;
  status: string;
  branch_id: number | null;
  branch_name: string | null;
  created_at: Date;
  barcodes: string[];
  on_hand: number;
}

export async function findLeafCategory(id: number) {
  const [row] = await db.select().from(catalogCategoriesTable).where(eq(catalogCategoriesTable.id, id)).limit(1);
  if (!row || row.archived_at !== null) return null;
  const children = await db
    .select({ value: count() })
    .from(catalogCategoriesTable)
    .where(and(eq(catalogCategoriesTable.parent_id, id), isNull(catalogCategoriesTable.archived_at)));
  return (children[0]?.value ?? 0) > 0 ? null : row;
}

export async function findUnit(id: number) {
  const [row] = await db.select().from(catalogUnitsTable).where(eq(catalogUnitsTable.id, id)).limit(1);
  return row ?? null;
}

async function hydrate(products: { product: typeof catalogProductsTable.$inferSelect; branch_name: string | null }[]): Promise<DraftRow[]> {
  if (products.length === 0) return [];
  const ids = products.map((p) => p.product.id);
  const [variants, categories] = await Promise.all([
    db
      .select({
        id: catalogVariantsTable.id,
        product_id: catalogVariantsTable.product_id,
        sku: catalogVariantsTable.sku,
      })
      .from(catalogVariantsTable)
      .where(inArray(catalogVariantsTable.product_id, ids)),
    db
      .select({ id: catalogCategoriesTable.id, name_ar: catalogCategoriesTable.name_ar })
      .from(catalogCategoriesTable)
      .where(inArray(catalogCategoriesTable.id, [...new Set(products.map((p) => p.product.category_id))])),
  ]);
  const variantIds = variants.map((v) => v.id);
  const [barcodes, balances] = await Promise.all([
    variantIds.length === 0
      ? []
      : db
          .select({ variant_id: catalogVariantUnitsTable.variant_id, code: catalogBarcodesTable.code })
          .from(catalogBarcodesTable)
          .innerJoin(catalogVariantUnitsTable, eq(catalogVariantUnitsTable.id, catalogBarcodesTable.variant_unit_id))
          .where(inArray(catalogVariantUnitsTable.variant_id, variantIds)),
    variantIds.length === 0
      ? []
      : db
          .select({
            variant_id: stockBalancesTable.variant_id,
            on_hand: sql<string>`sum(${stockBalancesTable.on_hand})`,
          })
          .from(stockBalancesTable)
          .where(inArray(stockBalancesTable.variant_id, variantIds))
          .groupBy(stockBalancesTable.variant_id),
  ]);

  return products.map(({ product, branch_name }) => {
    const variant = variants.find((v) => v.product_id === product.id);
    return {
      id: product.id,
      name_ar: product.name_ar,
      name_en: product.name_en,
      sku: variant?.sku ?? '',
      variant_id: variant?.id ?? 0,
      category_id: product.category_id,
      category_name_ar: categories.find((c) => c.id === product.category_id)?.name_ar ?? '',
      status: product.status,
      branch_id: product.draft_branch_id,
      branch_name,
      created_at: product.created_at,
      barcodes: barcodes.filter((b) => b.variant_id === variant?.id).map((b) => b.code),
      on_hand: Number(balances.find((b) => b.variant_id === variant?.id)?.on_hand ?? 0),
    };
  });
}

export async function findDraft(productId: number): Promise<DraftRow | null> {
  const rows = await db
    .select({ product: catalogProductsTable, branch_name: branchesTable.name })
    .from(catalogProductsTable)
    .leftJoin(branchesTable, eq(branchesTable.id, catalogProductsTable.draft_branch_id))
    .where(eq(catalogProductsTable.id, productId))
    .limit(1);
  const [row] = await hydrate(rows);
  return row ?? null;
}

/** Reads a row that has just stopped being a draft, so the caller can answer with it. */
export async function findAnyAsDraft(productId: number): Promise<DraftRow | null> {
  return findDraft(productId);
}

export async function findDrafts(
  params: PaginationParams,
  filter: { branchId?: number; includeDecided: boolean },
): Promise<{ rows: DraftRow[]; total: number }> {
  const conditions: SQL[] = [];
  if (!filter.includeDecided) conditions.push(eq(catalogProductsTable.is_branch_draft, true));
  if (filter.branchId !== undefined) conditions.push(eq(catalogProductsTable.draft_branch_id, filter.branchId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, totalRows] = await Promise.all([
    db
      .select({ product: catalogProductsTable, branch_name: branchesTable.name })
      .from(catalogProductsTable)
      .leftJoin(branchesTable, eq(branchesTable.id, catalogProductsTable.draft_branch_id))
      .where(where)
      // Oldest first: the one that has waited longest is the one a branch is
      // still unable to sell.
      .orderBy(asc(catalogProductsTable.created_at), asc(catalogProductsTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ value: count() }).from(catalogProductsTable).where(where),
  ]);
  return { rows: await hydrate(rows), total: totalRows[0]?.value ?? 0 };
}

/** Open drafts and the age of the oldest — the dashboard signal §٢ asks for. */
export async function draftSignal(branchId?: number): Promise<{ open: number; oldest_at: Date | null }> {
  const conditions: SQL[] = [eq(catalogProductsTable.is_branch_draft, true)];
  if (branchId !== undefined) conditions.push(eq(catalogProductsTable.draft_branch_id, branchId));
  const where = and(...conditions);
  const [total] = await db.select({ value: count() }).from(catalogProductsTable).where(where);
  const [oldest] = await db
    .select({ created_at: catalogProductsTable.created_at })
    .from(catalogProductsTable)
    .where(where)
    .orderBy(asc(catalogProductsTable.created_at))
    .limit(1);
  return { open: total?.value ?? 0, oldest_at: oldest?.created_at ?? null };
}

/**
 * The draft's codes follow it into the real item, on the target's base unit.
 * They are how that branch will scan it tomorrow; leaving them behind would
 * send the next scan back to "unknown barcode".
 */
export async function moveBarcodes(fromVariantId: number, toVariantId: number, targetBaseUnitId: number): Promise<void> {
  const [targetUnit] = await db
    .select({ id: catalogVariantUnitsTable.id })
    .from(catalogVariantUnitsTable)
    .where(
      and(
        eq(catalogVariantUnitsTable.variant_id, toVariantId),
        eq(catalogVariantUnitsTable.unit_id, targetBaseUnitId),
      ),
    )
    .limit(1);
  if (!targetUnit) return;
  const sourceUnits = await db
    .select({ id: catalogVariantUnitsTable.id })
    .from(catalogVariantUnitsTable)
    .where(eq(catalogVariantUnitsTable.variant_id, fromVariantId));
  if (sourceUnits.length === 0) return;
  await db
    .update(catalogBarcodesTable)
    .set({ variant_unit_id: targetUnit.id })
    .where(
      inArray(
        catalogBarcodesTable.variant_unit_id,
        sourceUnits.map((u) => u.id),
      ),
    );
}
