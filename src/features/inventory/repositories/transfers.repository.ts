import { and, count, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import { catalogProductsTable, catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import {
  stockCountLinesTable,
  stockCountsTable,
  stockTransferLinesTable,
  stockTransfersTable,
  type CountScope,
  type CountStatus,
  type StockCountRow,
  type StockTransferRow,
  type TransferStatus,
} from '../schemas/transfers.schema.js';
import type { Exec } from './stock.repository.js';

// ── Transfers ───────────────────────────────────────────────────────────────

export async function insertTransfer(
  exec: Exec,
  data: {
    number: string;
    from_branch_id: number;
    to_branch_id: number;
    status: TransferStatus;
    note: string | null;
    requested_by_user_id: number;
    approved_by_user_id: number | null;
  },
): Promise<StockTransferRow> {
  const rows = await exec.insert(stockTransfersTable).values(data).returning();
  return rows[0]!;
}

export async function insertTransferLines(
  exec: Exec,
  transferId: number,
  lines: { variant_id: number; qty_requested: number }[],
): Promise<void> {
  await exec.insert(stockTransferLinesTable).values(
    lines.map((line) => ({
      transfer_id: transferId,
      variant_id: line.variant_id,
      qty_requested: String(line.qty_requested),
    })),
  );
}

export async function updateTransfer(
  exec: Exec,
  id: number,
  data: Partial<typeof stockTransfersTable.$inferInsert>,
): Promise<StockTransferRow | undefined> {
  const rows = await exec
    .update(stockTransfersTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(stockTransfersTable.id, id))
    .returning();
  return rows[0];
}

export async function setShippedLine(
  exec: Exec,
  lineId: number,
  data: { qty_shipped: number; unit_cost_syp: number; unit_cost_usd: number },
): Promise<void> {
  await exec
    .update(stockTransferLinesTable)
    .set({
      qty_shipped: String(data.qty_shipped),
      unit_cost_syp: String(data.unit_cost_syp),
      unit_cost_usd: String(data.unit_cost_usd),
    })
    .where(eq(stockTransferLinesTable.id, lineId));
}

export async function setReceivedLine(exec: Exec, lineId: number, qtyReceived: number): Promise<void> {
  await exec
    .update(stockTransferLinesTable)
    .set({ qty_received: String(qtyReceived) })
    .where(eq(stockTransferLinesTable.id, lineId));
}

export async function findTransferById(id: number): Promise<StockTransferRow | undefined> {
  const rows = await db.select().from(stockTransfersTable).where(eq(stockTransfersTable.id, id)).limit(1);
  return rows[0];
}

export async function findTransferLines(transferId: number) {
  return db
    .select({
      id: stockTransferLinesTable.id,
      variant_id: stockTransferLinesTable.variant_id,
      sku: catalogVariantsTable.sku,
      product_name_ar: catalogProductsTable.name_ar,
      qty_requested: stockTransferLinesTable.qty_requested,
      qty_shipped: stockTransferLinesTable.qty_shipped,
      qty_received: stockTransferLinesTable.qty_received,
      unit_cost_syp: stockTransferLinesTable.unit_cost_syp,
      unit_cost_usd: stockTransferLinesTable.unit_cost_usd,
    })
    .from(stockTransferLinesTable)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, stockTransferLinesTable.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(eq(stockTransferLinesTable.transfer_id, transferId));
}

/** A branch sees transfers it sends **and** transfers it is waiting for. */
export async function findTransfers(
  params: PaginationParams,
  filter: { branchId?: number; status?: TransferStatus },
) {
  const conditions: SQL[] = [];
  if (filter.branchId !== undefined) {
    conditions.push(
      or(
        eq(stockTransfersTable.from_branch_id, filter.branchId),
        eq(stockTransfersTable.to_branch_id, filter.branchId),
      )!,
    );
  }
  if (filter.status !== undefined) conditions.push(eq(stockTransfersTable.status, filter.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, totalRows] = await Promise.all([
    db
      .select({ transfer: stockTransfersTable })
      .from(stockTransfersTable)
      .where(where)
      .orderBy(desc(stockTransfersTable.created_at), desc(stockTransfersTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ value: count() }).from(stockTransfersTable).where(where),
  ]);
  return { rows: rows.map((r) => r.transfer), total: totalRows[0]?.value ?? 0 };
}

export async function findBranchNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: branchesTable.id, name: branchesTable.name })
    .from(branchesTable)
    .where(inArray(branchesTable.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

// ── Counts ──────────────────────────────────────────────────────────────────

export async function insertCount(
  exec: Exec,
  data: {
    number: string;
    branch_id: number;
    scope: CountScope;
    category_id: number | null;
    status: CountStatus;
    note: string | null;
    started_by_user_id: number;
  },
): Promise<StockCountRow> {
  const rows = await exec.insert(stockCountsTable).values(data).returning();
  return rows[0]!;
}

export async function findCountById(id: number): Promise<StockCountRow | undefined> {
  const rows = await db.select().from(stockCountsTable).where(eq(stockCountsTable.id, id)).limit(1);
  return rows[0];
}

export async function upsertCountLine(
  data: {
    count_id: number;
    variant_id: number;
    counted_qty: number;
    system_qty: number;
    unit_cost_syp: number;
  },
  userId: number,
): Promise<void> {
  const values = {
    counted_qty: String(data.counted_qty),
    // The system quantity is re-stamped with every scan: the count is blind
    // and the shop keeps trading, so the comparison must be against the
    // moment of *this* scan, not the first one.
    system_qty: String(data.system_qty),
    unit_cost_syp: String(data.unit_cost_syp),
    counted_by_user_id: userId,
    counted_at: new Date(),
  };
  await db
    .insert(stockCountLinesTable)
    .values({ count_id: data.count_id, variant_id: data.variant_id, ...values })
    .onConflictDoUpdate({
      target: [stockCountLinesTable.count_id, stockCountLinesTable.variant_id],
      set: values,
    });
}

export async function findCountLines(countId: number) {
  return db
    .select({
      variant_id: stockCountLinesTable.variant_id,
      sku: catalogVariantsTable.sku,
      product_name_ar: catalogProductsTable.name_ar,
      counted_qty: stockCountLinesTable.counted_qty,
      system_qty: stockCountLinesTable.system_qty,
      unit_cost_syp: stockCountLinesTable.unit_cost_syp,
      counted_at: stockCountLinesTable.counted_at,
    })
    .from(stockCountLinesTable)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, stockCountLinesTable.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(eq(stockCountLinesTable.count_id, countId));
}

export async function updateCount(
  exec: Exec,
  id: number,
  data: Partial<typeof stockCountsTable.$inferInsert>,
): Promise<StockCountRow | undefined> {
  const rows = await exec.update(stockCountsTable).set(data).where(eq(stockCountsTable.id, id)).returning();
  return rows[0];
}

export async function findCounts(params: PaginationParams, filter: { branchId?: number; status?: CountStatus }) {
  const conditions: SQL[] = [];
  if (filter.branchId !== undefined) conditions.push(eq(stockCountsTable.branch_id, filter.branchId));
  if (filter.status !== undefined) conditions.push(eq(stockCountsTable.status, filter.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(stockCountsTable)
      .where(where)
      .orderBy(desc(stockCountsTable.created_at), desc(stockCountsTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ value: count() }).from(stockCountsTable).where(where),
  ]);
  return { rows, total: totalRows[0]?.value ?? 0 };
}

export async function countOpenCounts(branchId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(stockCountsTable)
    .where(and(eq(stockCountsTable.branch_id, branchId), eq(stockCountsTable.status, 'open')));
  return row?.value ?? 0;
}

/** Transfers waiting on this branch — approve mine to send, receive what is coming. */
export async function countPendingTransfers(branchId: number): Promise<{ to_approve: number; to_receive: number }> {
  const [approve] = await db
    .select({ value: count() })
    .from(stockTransfersTable)
    .where(and(eq(stockTransfersTable.from_branch_id, branchId), eq(stockTransfersTable.status, 'requested')));
  const [receive] = await db
    .select({ value: count() })
    .from(stockTransfersTable)
    .where(and(eq(stockTransfersTable.to_branch_id, branchId), eq(stockTransfersTable.status, 'in_transit')));
  return { to_approve: approve?.value ?? 0, to_receive: receive?.value ?? 0 };
}
