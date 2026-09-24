import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import { catalogProductsTable, catalogVariantUnitsTable, catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { catalogUnitsTable } from '../../catalog/schemas/units.schema.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { purchaseInvoiceLinesTable } from '../schemas/receipts.schema.js';
import { purchaseReturnLinesTable } from '../schemas/returns.schema.js';
import { stockCountLinesTable, stockTransferLinesTable } from '../schemas/transfers.schema.js';
import type { AdjustmentReason, AdjustmentStatus, InventoryDocType, StockMovementType } from '../schemas/inventory-enums.schema.js';
import {
  inventoryDocSequencesTable,
  inventorySettingsTable,
  stockAdjustmentLinesTable,
  stockAdjustmentsTable,
  stockBalancesTable,
  stockMovementsTable,
  stockReceiptLayersTable,
  type StockAdjustmentRow,
  type StockBalanceRow,
} from '../schemas/stock.schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * The branches an inventory screen may pick from. Sent with the settings so
 * the Flutter inventory feature never has to read the branches feature — the
 * same reason pricing sends them (`Features → Features ❌`).
 */
export async function findLiveBranches(): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: branchesTable.id, name: branchesTable.name })
    .from(branchesTable)
    .where(isNull(branchesTable.archived_at))
    .orderBy(branchesTable.name);
}

export async function findSettings(): Promise<{ approval_threshold_syp: string; expiry_alert_days: number } | null> {
  const [row] = await db.select().from(inventorySettingsTable).where(eq(inventorySettingsTable.id, 1));
  return row ?? null;
}

export async function saveSettings(
  data: { approval_threshold_syp: number; expiry_alert_days: number },
  userId: number,
): Promise<void> {
  const values = {
    approval_threshold_syp: String(data.approval_threshold_syp),
    expiry_alert_days: data.expiry_alert_days,
    updated_by_user_id: userId,
    updated_at: new Date(),
  };
  await db
    .insert(inventorySettingsTable)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: inventorySettingsTable.id, set: values });
}

// ── Numbering ───────────────────────────────────────────────────────────────

/**
 * The next number for (branch, type), inside the caller's transaction.
 *
 * `ON CONFLICT … last_number + 1 RETURNING` makes the increment and the read
 * one statement: two receipts saved in the same second cannot read the same
 * number, which is the whole point of a gapless sequence.
 */
export async function nextDocNumber(exec: Exec, branchId: number, docType: InventoryDocType): Promise<number> {
  const rows = await exec
    .insert(inventoryDocSequencesTable)
    .values({ branch_id: branchId, doc_type: docType, last_number: 1 })
    .onConflictDoUpdate({
      target: [inventoryDocSequencesTable.branch_id, inventoryDocSequencesTable.doc_type],
      set: { last_number: sql`${inventoryDocSequencesTable.last_number} + 1` },
    })
    .returning({ last: inventoryDocSequencesTable.last_number });
  return rows[0]!.last;
}

// ── Balances and the ledger ─────────────────────────────────────────────────

/**
 * The balance row, **locked** for the rest of the transaction. Everything that
 * writes stock reads through here: two sales of the last piece must queue, or
 * both read "1 available" and both sell it.
 */
export async function lockBalance(exec: Exec, branchId: number, variantId: number): Promise<StockBalanceRow | null> {
  const rows = await exec
    .select()
    .from(stockBalancesTable)
    .where(and(eq(stockBalancesTable.branch_id, branchId), eq(stockBalancesTable.variant_id, variantId)))
    .for('update');
  return rows[0] ?? null;
}

export async function upsertBalance(
  exec: Exec,
  branchId: number,
  variantId: number,
  data: { on_hand: number; avg_cost_syp: number; avg_cost_usd: number },
): Promise<void> {
  const values = {
    on_hand: String(data.on_hand),
    avg_cost_syp: String(data.avg_cost_syp),
    avg_cost_usd: String(data.avg_cost_usd),
    updated_at: new Date(),
  };
  await exec
    .insert(stockBalancesTable)
    .values({ branch_id: branchId, variant_id: variantId, ...values })
    .onConflictDoUpdate({
      target: [stockBalancesTable.branch_id, stockBalancesTable.variant_id],
      set: values,
    });
}

export async function setReorderThreshold(
  branchId: number,
  variantId: number,
  threshold: number | null,
): Promise<void> {
  const values = { reorder_threshold: threshold === null ? null : String(threshold), updated_at: new Date() };
  await db
    .insert(stockBalancesTable)
    .values({ branch_id: branchId, variant_id: variantId, ...values })
    .onConflictDoUpdate({ target: [stockBalancesTable.branch_id, stockBalancesTable.variant_id], set: values });
}

export interface MovementInput {
  branch_id: number;
  variant_id: number;
  type: StockMovementType;
  qty_base: number;
  unit_cost_syp: number | null;
  unit_cost_usd: number | null;
  source_doc_type: InventoryDocType | null;
  source_doc_id: number | null;
  note?: string | null;
}

export async function insertMovements(exec: Exec, rows: MovementInput[], userId: number): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(stockMovementsTable).values(
    rows.map((row) => ({
      ...row,
      qty_base: String(row.qty_base),
      unit_cost_syp: row.unit_cost_syp === null ? null : String(row.unit_cost_syp),
      unit_cost_usd: row.unit_cost_usd === null ? null : String(row.unit_cost_usd),
      note: row.note ?? null,
      created_by_user_id: userId,
    })),
  );
}

export async function insertLayers(
  exec: Exec,
  rows: {
    branch_id: number;
    variant_id: number;
    receipt_id: number;
    qty_base: number;
    unit_cost_syp: number;
    unit_cost_usd: number;
    expires_at: Date | null;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(stockReceiptLayersTable).values(
    rows.map((row) => ({
      ...row,
      qty_base: String(row.qty_base),
      remaining_base: String(row.qty_base),
      unit_cost_syp: String(row.unit_cost_syp),
      unit_cost_usd: String(row.unit_cost_usd),
    })),
  );
}

const variantJoin = {
  variant_id: catalogVariantsTable.id,
  sku: catalogVariantsTable.sku,
  product_id: catalogProductsTable.id,
  product_name_ar: catalogProductsTable.name_ar,
  product_name_en: catalogProductsTable.name_en,
};

/** Balances at one branch, newest movement first is meaningless here — ordered by product name. */
export async function findBalances(
  branchId: number,
  params: PaginationParams,
  filter: { search?: string },
): Promise<{ rows: BalanceRow[]; total: number }> {
  const conditions: SQL[] = [eq(stockBalancesTable.branch_id, branchId)];
  if (filter.search) conditions.push(ilike(catalogProductsTable.search_text, `%${filter.search}%`));
  const where = and(...conditions);
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        ...variantJoin,
        on_hand: stockBalancesTable.on_hand,
        reserved: stockBalancesTable.reserved,
        avg_cost_syp: stockBalancesTable.avg_cost_syp,
        avg_cost_usd: stockBalancesTable.avg_cost_usd,
        reorder_threshold: stockBalancesTable.reorder_threshold,
      })
      .from(stockBalancesTable)
      .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, stockBalancesTable.variant_id))
      .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
      .where(where)
      .orderBy(asc(catalogProductsTable.name_ar), asc(catalogVariantsTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db
      .select({ value: count() })
      .from(stockBalancesTable)
      .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, stockBalancesTable.variant_id))
      .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
      .where(where),
  ]);
  return { rows, total: totalRows[0]?.value ?? 0 };
}

export type BalanceRow = {
  variant_id: number;
  sku: string;
  product_id: number;
  product_name_ar: string;
  product_name_en: string | null;
  on_hand: string;
  reserved: string;
  avg_cost_syp: string;
  avg_cost_usd: string;
  reorder_threshold: string | null;
};

/** Every balance at a branch — for the signals, which count rather than page. */
export async function findAllBalances(branchId: number): Promise<BalanceRow[]> {
  return db
    .select({
      ...variantJoin,
      on_hand: stockBalancesTable.on_hand,
      reserved: stockBalancesTable.reserved,
      avg_cost_syp: stockBalancesTable.avg_cost_syp,
      avg_cost_usd: stockBalancesTable.avg_cost_usd,
      reorder_threshold: stockBalancesTable.reorder_threshold,
    })
    .from(stockBalancesTable)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, stockBalancesTable.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(eq(stockBalancesTable.branch_id, branchId));
}

export async function findBalancesOf(branchId: number, variantIds: number[]): Promise<StockBalanceRow[]> {
  if (variantIds.length === 0) return [];
  return db
    .select()
    .from(stockBalancesTable)
    .where(and(eq(stockBalancesTable.branch_id, branchId), inArray(stockBalancesTable.variant_id, variantIds)));
}

export async function findMovements(
  branchId: number,
  params: PaginationParams,
  filter: { variantId?: number },
) {
  const conditions: SQL[] = [eq(stockMovementsTable.branch_id, branchId)];
  if (filter.variantId !== undefined) conditions.push(eq(stockMovementsTable.variant_id, filter.variantId));
  const where = and(...conditions);
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: stockMovementsTable.id,
        variant_id: stockMovementsTable.variant_id,
        sku: catalogVariantsTable.sku,
        product_name_ar: catalogProductsTable.name_ar,
        type: stockMovementsTable.type,
        qty_base: stockMovementsTable.qty_base,
        unit_cost_syp: stockMovementsTable.unit_cost_syp,
        source_doc_type: stockMovementsTable.source_doc_type,
        source_doc_id: stockMovementsTable.source_doc_id,
        note: stockMovementsTable.note,
        created_at: stockMovementsTable.created_at,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
      })
      .from(stockMovementsTable)
      .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, stockMovementsTable.variant_id))
      .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
      .leftJoin(usersTable, eq(usersTable.id, stockMovementsTable.created_by_user_id))
      .where(where)
      .orderBy(desc(stockMovementsTable.created_at), desc(stockMovementsTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ value: count() }).from(stockMovementsTable).where(where),
  ]);
  return { rows, total: totalRows[0]?.value ?? 0 };
}

/** How much of a variant left as sales in a window — what a threshold suggestion is built from. */
export async function sumSoldSince(branchId: number, variantId: number, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(-${stockMovementsTable.qty_base}), 0)` })
    .from(stockMovementsTable)
    .where(
      and(
        eq(stockMovementsTable.branch_id, branchId),
        eq(stockMovementsTable.variant_id, variantId),
        eq(stockMovementsTable.type, 'sale'),
        gte(stockMovementsTable.created_at, since),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Layers that expire within the window and still have stock left. */
export async function findExpiring(branchId: number, before: Date) {
  return db
    .select({
      variant_id: stockReceiptLayersTable.variant_id,
      sku: catalogVariantsTable.sku,
      product_name_ar: catalogProductsTable.name_ar,
      remaining_base: stockReceiptLayersTable.remaining_base,
      expires_at: stockReceiptLayersTable.expires_at,
    })
    .from(stockReceiptLayersTable)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, stockReceiptLayersTable.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(
      and(
        eq(stockReceiptLayersTable.branch_id, branchId),
        isNotNull(stockReceiptLayersTable.expires_at),
        lte(stockReceiptLayersTable.expires_at, before),
        sql`${stockReceiptLayersTable.remaining_base} > 0`,
      ),
    )
    .orderBy(asc(stockReceiptLayersTable.expires_at))
    .limit(100);
}

// ── Adjustments ─────────────────────────────────────────────────────────────

export async function insertAdjustment(
  exec: Exec,
  data: {
    branch_id: number;
    number: string;
    reason: AdjustmentReason;
    note: string;
    status: AdjustmentStatus;
    total_value_syp: number;
  },
  userId: number,
): Promise<StockAdjustmentRow> {
  const rows = await exec
    .insert(stockAdjustmentsTable)
    .values({ ...data, total_value_syp: String(data.total_value_syp), created_by_user_id: userId })
    .returning();
  return rows[0]!;
}

export async function insertAdjustmentLines(
  exec: Exec,
  adjustmentId: number,
  lines: { variant_id: number; qty_base: number; unit_cost_syp: number }[],
): Promise<void> {
  await exec.insert(stockAdjustmentLinesTable).values(
    lines.map((line) => ({
      adjustment_id: adjustmentId,
      variant_id: line.variant_id,
      qty_base: String(line.qty_base),
      unit_cost_syp: String(line.unit_cost_syp),
    })),
  );
}

export async function findAdjustmentById(id: number): Promise<StockAdjustmentRow | undefined> {
  const rows = await db.select().from(stockAdjustmentsTable).where(eq(stockAdjustmentsTable.id, id)).limit(1);
  return rows[0];
}

export async function findAdjustmentLines(adjustmentId: number) {
  return db
    .select({
      variant_id: stockAdjustmentLinesTable.variant_id,
      sku: catalogVariantsTable.sku,
      product_name_ar: catalogProductsTable.name_ar,
      qty_base: stockAdjustmentLinesTable.qty_base,
      unit_cost_syp: stockAdjustmentLinesTable.unit_cost_syp,
    })
    .from(stockAdjustmentLinesTable)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, stockAdjustmentLinesTable.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(eq(stockAdjustmentLinesTable.adjustment_id, adjustmentId));
}

export async function findAdjustments(
  params: PaginationParams,
  filter: { branchId?: number; status?: AdjustmentStatus },
) {
  const conditions: SQL[] = [];
  if (filter.branchId !== undefined) conditions.push(eq(stockAdjustmentsTable.branch_id, filter.branchId));
  if (filter.status !== undefined) conditions.push(eq(stockAdjustmentsTable.status, filter.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(stockAdjustmentsTable)
      .where(where)
      .orderBy(desc(stockAdjustmentsTable.created_at), desc(stockAdjustmentsTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ value: count() }).from(stockAdjustmentsTable).where(where),
  ]);
  return { rows, total: totalRows[0]?.value ?? 0 };
}

export async function decideAdjustment(
  exec: Exec,
  id: number,
  status: AdjustmentStatus,
  userId: number,
): Promise<StockAdjustmentRow | undefined> {
  const rows = await exec
    .update(stockAdjustmentsTable)
    .set({ status, decided_by_user_id: userId, decided_at: new Date() })
    .where(eq(stockAdjustmentsTable.id, id))
    .returning();
  return rows[0];
}

export async function countPendingAdjustments(branchId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(stockAdjustmentsTable)
    .where(and(eq(stockAdjustmentsTable.branch_id, branchId), eq(stockAdjustmentsTable.status, 'pending_approval')));
  return row?.value ?? 0;
}

/** Layers are consumed oldest-first when stock leaves, so an expiry warning stays honest. */
export async function consumeLayers(exec: Exec, branchId: number, variantId: number, qty: number): Promise<void> {
  let left = qty;
  const layers = await exec
    .select()
    .from(stockReceiptLayersTable)
    .where(
      and(
        eq(stockReceiptLayersTable.branch_id, branchId),
        eq(stockReceiptLayersTable.variant_id, variantId),
        sql`${stockReceiptLayersTable.remaining_base} > 0`,
      ),
    )
    .orderBy(asc(stockReceiptLayersTable.received_at), asc(stockReceiptLayersTable.id))
    .for('update');
  for (const layer of layers) {
    if (left <= 0) break;
    const remaining = Number(layer.remaining_base);
    const take = Math.min(remaining, left);
    left -= take;
    await exec
      .update(stockReceiptLayersTable)
      .set({ remaining_base: String(Number((remaining - take).toFixed(3))) })
      .where(eq(stockReceiptLayersTable.id, layer.id));
  }
  // Anything left over means stock left that no layer accounts for (a sale
  // before its receipt was entered). The ledger still records it; the layers
  // simply have nothing to consume, which is the honest answer.
}

/**
 * The units a variant is bought and sold in, read from the catalog's own
 * tables. A **schema** import, not a repository one: reading another feature's
 * rows is allowed (the FK already ties them), calling its service is not.
 */
export async function findVariantUnits(variantIds: number[]) {
  if (variantIds.length === 0) return [];
  return db
    .select({
      variant_id: catalogVariantUnitsTable.variant_id,
      unit_id: catalogVariantUnitsTable.unit_id,
      factor: catalogVariantUnitsTable.factor,
    })
    .from(catalogVariantUnitsTable)
    .where(inArray(catalogVariantUnitsTable.variant_id, variantIds));
}

/** Variants that exist and are not on an archived product — what may receive stock. */
export async function findLiveVariants(variantIds: number[]) {
  if (variantIds.length === 0) return [];
  return db
    .select({ variant_id: catalogVariantsTable.id, product_id: catalogProductsTable.id, archived_at: catalogProductsTable.archived_at })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(inArray(catalogVariantsTable.id, variantIds));
}

/** Movements pointing at these variants — or at every variant of these products. */
export async function countMovementsFor(entity: 'product' | 'variant', ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const variantIds =
    entity === 'variant'
      ? ids
      : (
          await db
            .select({ id: catalogVariantsTable.id })
            .from(catalogVariantsTable)
            .where(inArray(catalogVariantsTable.product_id, ids))
        ).map((row) => row.id);
  if (variantIds.length === 0) return 0;
  const [row] = await db
    .select({ value: count() })
    .from(stockMovementsTable)
    .where(inArray(stockMovementsTable.variant_id, variantIds));
  return row?.value ?? 0;
}

/** Every branch that holds this variant — what a merge has to combine. */
export async function findBalancesOfVariant(variantId: number): Promise<StockBalanceRow[]> {
  return db.select().from(stockBalancesTable).where(eq(stockBalancesTable.variant_id, variantId));
}

/**
 * Points **every** inventory row at another variant, and drops the source's
 * balance rows (already merged into the target's).
 *
 * Documents are repointed too, not only the ledger: the invoice really did
 * deliver this item, and a merge is the branch saying so. Leaving the
 * paperwork behind would break the delete that follows (every one of these
 * foreign keys is `RESTRICT`) and, worse, leave a purchase invoice naming a
 * product nobody can open.
 *
 * A stocktake is the one place where both variants may already be on the same
 * document, and its line is unique per (count, variant). The source line is
 * dropped there rather than moved: the sheet counted the same shelf twice
 * under two names, and the target's line is the one that carries the system
 * quantity it was blind-counted against.
 */
export async function repointVariant(exec: Exec, fromVariantId: number, toVariantId: number): Promise<void> {
  await exec
    .update(stockMovementsTable)
    .set({ variant_id: toVariantId })
    .where(eq(stockMovementsTable.variant_id, fromVariantId));
  await exec
    .update(stockReceiptLayersTable)
    .set({ variant_id: toVariantId })
    .where(eq(stockReceiptLayersTable.variant_id, fromVariantId));
  await exec
    .update(purchaseInvoiceLinesTable)
    .set({ variant_id: toVariantId })
    .where(eq(purchaseInvoiceLinesTable.variant_id, fromVariantId));
  await exec
    .update(purchaseReturnLinesTable)
    .set({ variant_id: toVariantId })
    .where(eq(purchaseReturnLinesTable.variant_id, fromVariantId));
  await exec
    .update(stockAdjustmentLinesTable)
    .set({ variant_id: toVariantId })
    .where(eq(stockAdjustmentLinesTable.variant_id, fromVariantId));
  await exec
    .update(stockTransferLinesTable)
    .set({ variant_id: toVariantId })
    .where(eq(stockTransferLinesTable.variant_id, fromVariantId));
  const clashingCounts = await exec
    .select({ count_id: stockCountLinesTable.count_id })
    .from(stockCountLinesTable)
    .where(eq(stockCountLinesTable.variant_id, toVariantId));
  if (clashingCounts.length > 0)
    await exec
      .delete(stockCountLinesTable)
      .where(
        and(
          eq(stockCountLinesTable.variant_id, fromVariantId),
          inArray(
            stockCountLinesTable.count_id,
            clashingCounts.map((row) => row.count_id),
          ),
        ),
      );
  await exec
    .update(stockCountLinesTable)
    .set({ variant_id: toVariantId })
    .where(eq(stockCountLinesTable.variant_id, fromVariantId));
  await exec.delete(stockBalancesTable).where(eq(stockBalancesTable.variant_id, fromVariantId));
}

/**
 * Items a receiving or damage line may name, searched the way the catalog
 * searches (folded Arabic over `search_text`, and an exact barcode or SKU —
 * typing a scanned code finds the item).
 *
 * It lives here, not in the catalog, because the answer carries **stock**: a
 * damage line is written against what the branch holds, and seeing «الرصيد ٣»
 * beside the name is what stops a reader writing off six.
 */
export async function searchVariantsForDocument(
  search: string,
  branchId: number,
  limit: number,
): Promise<
  {
    variant_id: number;
    sku: string;
    product_name_ar: string;
    base_unit_id: number;
    on_hand: string | null;
  }[]
> {
  const term = `%${search}%`;
  const rows = await db
    .select({
      variant_id: catalogVariantsTable.id,
      sku: catalogVariantsTable.sku,
      product_name_ar: catalogProductsTable.name_ar,
      base_unit_id: catalogVariantsTable.base_unit_id,
      on_hand: stockBalancesTable.on_hand,
    })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .leftJoin(
      stockBalancesTable,
      and(
        eq(stockBalancesTable.variant_id, catalogVariantsTable.id),
        eq(stockBalancesTable.branch_id, branchId),
      ),
    )
    .where(
      and(
        isNull(catalogProductsTable.archived_at),
        sql`(${catalogProductsTable.search_text} ILIKE ${term} OR ${catalogVariantsTable.sku} ILIKE ${term} OR EXISTS (
          SELECT 1 FROM catalog_barcodes b
          JOIN catalog_variant_units vu ON vu.id = b.variant_unit_id
          WHERE vu.variant_id = ${catalogVariantsTable.id} AND b.code = ${search}
        ))`,
      ),
    )
    .orderBy(asc(catalogProductsTable.name_ar), asc(catalogVariantsTable.id))
    .limit(limit);
  return rows;
}

/** The units one variant may be written in — a carton as well as a piece. */
export async function findVariantUnitOptions(variantIds: number[]) {
  if (variantIds.length === 0) return [];
  return db
    .select({
      variant_id: catalogVariantUnitsTable.variant_id,
      unit_id: catalogVariantUnitsTable.unit_id,
      unit_name_ar: catalogUnitsTable.name_ar,
      factor: catalogVariantUnitsTable.factor,
      is_base: catalogVariantUnitsTable.is_base,
    })
    .from(catalogVariantUnitsTable)
    .innerJoin(catalogUnitsTable, eq(catalogUnitsTable.id, catalogVariantUnitsTable.unit_id))
    .where(inArray(catalogVariantUnitsTable.variant_id, variantIds))
    .orderBy(asc(catalogVariantUnitsTable.factor));
}
