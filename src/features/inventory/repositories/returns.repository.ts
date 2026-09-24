import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import { catalogProductsTable, catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { purchaseInvoicesTable } from '../schemas/receipts.schema.js';
import { purchaseReturnLinesTable, purchaseReturnsTable, type PurchaseReturnRow } from '../schemas/returns.schema.js';
import { suppliersTable } from '../schemas/suppliers.schema.js';
import type { Exec } from './stock.repository.js';

export async function insertReturn(
  exec: Exec,
  data: {
    number: string;
    branch_id: number;
    supplier_id: number;
    receipt_id: number;
    note: string;
    total_syp: number;
  },
  userId: number,
): Promise<PurchaseReturnRow> {
  const rows = await exec
    .insert(purchaseReturnsTable)
    .values({ ...data, total_syp: String(data.total_syp), created_by_user_id: userId })
    .returning();
  return rows[0]!;
}

export async function insertLines(
  exec: Exec,
  returnId: number,
  lines: { variant_id: number; qty_base: number; unit_cost_syp: number; unit_cost_usd: number }[],
): Promise<void> {
  await exec.insert(purchaseReturnLinesTable).values(
    lines.map((line) => ({
      return_id: returnId,
      variant_id: line.variant_id,
      qty_base: String(line.qty_base),
      unit_cost_syp: String(line.unit_cost_syp),
      unit_cost_usd: String(line.unit_cost_usd),
    })),
  );
}

/**
 * How much of each line of one invoice has already gone back. Read inside the
 * same transaction that writes the new return, so two people returning the
 * last box at once cannot both pass the cap.
 */
export async function returnedByVariant(exec: Exec, receiptId: number): Promise<Map<number, number>> {
  const rows = await exec
    .select({
      variant_id: purchaseReturnLinesTable.variant_id,
      qty_base: sql<string>`sum(${purchaseReturnLinesTable.qty_base})`,
    })
    .from(purchaseReturnLinesTable)
    .innerJoin(purchaseReturnsTable, eq(purchaseReturnsTable.id, purchaseReturnLinesTable.return_id))
    .where(eq(purchaseReturnsTable.receipt_id, receiptId))
    .groupBy(purchaseReturnLinesTable.variant_id);
  return new Map(rows.map((row) => [row.variant_id, Number(row.qty_base)]));
}

export async function findById(id: number) {
  const rows = await db
    .select({
      doc: purchaseReturnsTable,
      branch_name: branchesTable.name,
      supplier_name: suppliersTable.name,
      receipt_number: purchaseInvoicesTable.number,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
    })
    .from(purchaseReturnsTable)
    .innerJoin(branchesTable, eq(branchesTable.id, purchaseReturnsTable.branch_id))
    .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseReturnsTable.supplier_id))
    .innerJoin(purchaseInvoicesTable, eq(purchaseInvoicesTable.id, purchaseReturnsTable.receipt_id))
    .leftJoin(usersTable, eq(usersTable.id, purchaseReturnsTable.created_by_user_id))
    .where(eq(purchaseReturnsTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findLines(returnId: number) {
  return db
    .select({
      variant_id: purchaseReturnLinesTable.variant_id,
      sku: catalogVariantsTable.sku,
      product_name_ar: catalogProductsTable.name_ar,
      qty_base: purchaseReturnLinesTable.qty_base,
      unit_cost_syp: purchaseReturnLinesTable.unit_cost_syp,
    })
    .from(purchaseReturnLinesTable)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, purchaseReturnLinesTable.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(eq(purchaseReturnLinesTable.return_id, returnId));
}

export async function findMany(
  params: PaginationParams,
  filter: { branchId?: number; supplierId?: number; receiptId?: number },
) {
  const conditions: SQL[] = [];
  if (filter.branchId !== undefined) conditions.push(eq(purchaseReturnsTable.branch_id, filter.branchId));
  if (filter.supplierId !== undefined) conditions.push(eq(purchaseReturnsTable.supplier_id, filter.supplierId));
  if (filter.receiptId !== undefined) conditions.push(eq(purchaseReturnsTable.receipt_id, filter.receiptId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        doc: purchaseReturnsTable,
        branch_name: branchesTable.name,
        supplier_name: suppliersTable.name,
        receipt_number: purchaseInvoicesTable.number,
      })
      .from(purchaseReturnsTable)
      .innerJoin(branchesTable, eq(branchesTable.id, purchaseReturnsTable.branch_id))
      .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseReturnsTable.supplier_id))
      .innerJoin(purchaseInvoicesTable, eq(purchaseInvoicesTable.id, purchaseReturnsTable.receipt_id))
      .where(where)
      .orderBy(desc(purchaseReturnsTable.created_at), desc(purchaseReturnsTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ value: count() }).from(purchaseReturnsTable).where(where),
  ]);
  return { rows, total: totalRows[0]?.value ?? 0 };
}
