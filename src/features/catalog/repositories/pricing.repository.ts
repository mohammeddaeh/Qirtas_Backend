import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import type { PricingCurrency } from '../schemas/catalog-enums.schema.js';
import {
  catalogBranchListingsTable,
  catalogBranchPricesTable,
  catalogExchangeRatesTable,
  catalogPriceHistoryTable,
  catalogPricingSettingsTable,
  catalogVariantPricesTable,
  type BranchPriceRow,
  type VariantPriceRow,
} from '../schemas/pricing.schema.js';
import { catalogProductsTable, catalogVariantsTable } from '../schemas/products.schema.js';
import type { RoundingBand } from '../services/price-resolution.js';

/** A central price row as the service reads it. */
export type VariantPriceLike = VariantPriceRow;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

// ── Settings ────────────────────────────────────────────────────────────────

export async function findRoundingBands(): Promise<RoundingBand[] | null> {
  const [row] = await db.select().from(catalogPricingSettingsTable).where(eq(catalogPricingSettingsTable.id, 1));
  return row?.rounding_bands ?? null;
}

export async function saveRoundingBands(bands: RoundingBand[], userId: number): Promise<void> {
  await db
    .insert(catalogPricingSettingsTable)
    .values({ id: 1, rounding_bands: bands, updated_by_user_id: userId })
    .onConflictDoUpdate({
      target: catalogPricingSettingsTable.id,
      set: { rounding_bands: bands, updated_by_user_id: userId, updated_at: new Date() },
    });
}

export async function findCurrentRate(): Promise<{ usd_to_syp: string; effective_at: Date } | null> {
  const [row] = await db
    .select({ usd_to_syp: catalogExchangeRatesTable.usd_to_syp, effective_at: catalogExchangeRatesTable.effective_at })
    .from(catalogExchangeRatesTable)
    .orderBy(desc(catalogExchangeRatesTable.effective_at), desc(catalogExchangeRatesTable.id))
    .limit(1);
  return row ?? null;
}

export async function insertRate(usdToSyp: number, userId: number): Promise<void> {
  await db.insert(catalogExchangeRatesTable).values({ usd_to_syp: String(usdToSyp), created_by_user_id: userId });
}

// ── Prices ──────────────────────────────────────────────────────────────────

export async function findVariantPrices(variantIds: number[], exec: Exec = db): Promise<VariantPriceRow[]> {
  if (variantIds.length === 0) return [];
  return exec.select().from(catalogVariantPricesTable).where(inArray(catalogVariantPricesTable.variant_id, variantIds));
}

export async function upsertVariantPrice(
  row: {
    variant_id: number;
    amount: number;
    currency: PricingCurrency;
    wholesale_amount: number | null;
    wholesale_min_qty: number | null;
  },
  userId: number,
  exec: Exec = db,
): Promise<void> {
  const values = {
    amount: String(row.amount),
    currency: row.currency,
    wholesale_amount: row.wholesale_amount === null ? null : String(row.wholesale_amount),
    wholesale_min_qty: row.wholesale_min_qty === null ? null : String(row.wholesale_min_qty),
    updated_by_user_id: userId,
    updated_at: new Date(),
  };
  await exec
    .insert(catalogVariantPricesTable)
    .values({ variant_id: row.variant_id, ...values })
    .onConflictDoUpdate({ target: catalogVariantPricesTable.variant_id, set: values });
}

/** Branch prices for [variantIds] — at one branch, or at every branch when [branchId] is undefined. */
export async function findBranchPrices(variantIds: number[], branchId?: number): Promise<BranchPriceRow[]> {
  if (variantIds.length === 0) return [];
  const byVariant = inArray(catalogBranchPricesTable.variant_id, variantIds);
  return db
    .select()
    .from(catalogBranchPricesTable)
    .where(branchId === undefined ? byVariant : and(byVariant, eq(catalogBranchPricesTable.branch_id, branchId)));
}

export async function upsertBranchPrice(
  branchId: number,
  variantId: number,
  amount: number,
  currency: PricingCurrency,
  userId: number,
): Promise<void> {
  const set = { amount: String(amount), currency, updated_by_user_id: userId, updated_at: new Date() };
  await db
    .insert(catalogBranchPricesTable)
    .values({ branch_id: branchId, variant_id: variantId, ...set })
    .onConflictDoUpdate({ target: [catalogBranchPricesTable.branch_id, catalogBranchPricesTable.variant_id], set });
}

export async function deleteBranchPrice(branchId: number, variantId: number): Promise<void> {
  await db
    .delete(catalogBranchPricesTable)
    .where(and(eq(catalogBranchPricesTable.branch_id, branchId), eq(catalogBranchPricesTable.variant_id, variantId)));
}

// ── Listing ─────────────────────────────────────────────────────────────────

/** Variants withdrawn at [branchId] (or anywhere, when undefined). No row = listed. */
export async function findUnlisted(
  variantIds: number[],
  branchId?: number,
): Promise<{ branch_id: number; variant_id: number }[]> {
  if (variantIds.length === 0) return [];
  const conditions = [
    inArray(catalogBranchListingsTable.variant_id, variantIds),
    eq(catalogBranchListingsTable.is_listed, false),
  ];
  if (branchId !== undefined) conditions.push(eq(catalogBranchListingsTable.branch_id, branchId));
  return db
    .select({ branch_id: catalogBranchListingsTable.branch_id, variant_id: catalogBranchListingsTable.variant_id })
    .from(catalogBranchListingsTable)
    .where(and(...conditions));
}

/** Listed again = the row goes: the default *is* listed, so a `true` row would only be one more thing to keep in step. */
export async function setListing(branchId: number, variantId: number, isListed: boolean, userId: number): Promise<void> {
  const key = and(
    eq(catalogBranchListingsTable.branch_id, branchId),
    eq(catalogBranchListingsTable.variant_id, variantId),
  );
  if (isListed) {
    await db.delete(catalogBranchListingsTable).where(key);
    return;
  }
  await db
    .insert(catalogBranchListingsTable)
    .values({ branch_id: branchId, variant_id: variantId, is_listed: false, updated_by_user_id: userId })
    .onConflictDoUpdate({
      target: [catalogBranchListingsTable.branch_id, catalogBranchListingsTable.variant_id],
      set: { is_listed: false, updated_by_user_id: userId, updated_at: new Date() },
    });
}

// ── History ─────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  variant_id: number;
  branch_id: number | null;
  field: 'retail' | 'wholesale' | 'wholesale_min_qty';
  old_amount: number | null;
  old_currency: PricingCurrency | null;
  new_amount: number | null;
  new_currency: PricingCurrency | null;
  source: 'manual' | 'bulk';
}

export async function insertHistory(entries: HistoryEntry[], userId: number, exec: Exec = db): Promise<void> {
  if (entries.length === 0) return;
  await exec.insert(catalogPriceHistoryTable).values(
    entries.map((e) => ({
      ...e,
      old_amount: e.old_amount === null ? null : String(e.old_amount),
      new_amount: e.new_amount === null ? null : String(e.new_amount),
      changed_by_user_id: userId,
    })),
  );
}

export async function findHistory(variantId: number, limit: number) {
  return db
    .select({
      id: catalogPriceHistoryTable.id,
      branch_id: catalogPriceHistoryTable.branch_id,
      field: catalogPriceHistoryTable.field,
      old_amount: catalogPriceHistoryTable.old_amount,
      old_currency: catalogPriceHistoryTable.old_currency,
      new_amount: catalogPriceHistoryTable.new_amount,
      new_currency: catalogPriceHistoryTable.new_currency,
      source: catalogPriceHistoryTable.source,
      changed_at: catalogPriceHistoryTable.changed_at,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
    })
    .from(catalogPriceHistoryTable)
    .leftJoin(usersTable, eq(usersTable.id, catalogPriceHistoryTable.changed_by_user_id))
    .where(eq(catalogPriceHistoryTable.variant_id, variantId))
    .orderBy(desc(catalogPriceHistoryTable.changed_at), desc(catalogPriceHistoryTable.id))
    .limit(limit);
}

// ── Scope reads ─────────────────────────────────────────────────────────────

/** Live (not archived) products' variants in the given categories, or of the given brand. */
export async function findLiveVariantsIn(scope: { categoryIds?: number[]; brandId?: number }) {
  const conditions = [isNull(catalogProductsTable.archived_at)];
  if (scope.categoryIds) conditions.push(inArray(catalogProductsTable.category_id, scope.categoryIds));
  if (scope.brandId !== undefined) conditions.push(eq(catalogProductsTable.brand_id, scope.brandId));
  return db
    .select({
      variant_id: catalogVariantsTable.id,
      sku: catalogVariantsTable.sku,
      product_id: catalogProductsTable.id,
      product_name_ar: catalogProductsTable.name_ar,
      category_id: catalogProductsTable.category_id,
      product_price_policy: catalogProductsTable.price_policy,
      product_band_percent: catalogProductsTable.price_band_percent,
    })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(and(...conditions));
}

/** Every sellable variant: published product, active variant, not archived — what a branch actually sells. */
export async function findSellableVariants() {
  return db
    .select({
      variant_id: catalogVariantsTable.id,
      sku: catalogVariantsTable.sku,
      product_id: catalogProductsTable.id,
      product_name_ar: catalogProductsTable.name_ar,
      product_name_en: catalogProductsTable.name_en,
      category_id: catalogProductsTable.category_id,
      product_price_policy: catalogProductsTable.price_policy,
      product_band_percent: catalogProductsTable.price_band_percent,
    })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(
      and(
        isNull(catalogProductsTable.archived_at),
        eq(catalogProductsTable.status, 'active'),
        eq(catalogVariantsTable.status, 'active'),
      ),
    );
}

export async function bulkUpdateCentral(
  updates: { variant_id: number; amount: number; currency: PricingCurrency; old_amount: number }[],
  userId: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const u of updates) {
      await tx
        .update(catalogVariantPricesTable)
        .set({ amount: String(u.amount), updated_by_user_id: userId, updated_at: new Date() })
        .where(eq(catalogVariantPricesTable.variant_id, u.variant_id));
    }
    await insertHistory(
      updates.map((u) => ({
        variant_id: u.variant_id,
        branch_id: null,
        field: 'retail' as const,
        old_amount: u.old_amount,
        old_currency: u.currency,
        new_amount: u.amount,
        new_currency: u.currency,
        source: 'bulk' as const,
      })),
      userId,
      tx,
    );
  });
}

// ── Branches (read-only — identity owns them) ───────────────────────────────

/** Live branches, for naming a branch price and for "every branch" views. */
export async function findLiveBranches(): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: branchesTable.id, name: branchesTable.name })
    .from(branchesTable)
    .where(isNull(branchesTable.archived_at))
    .orderBy(branchesTable.name);
}
