import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import { catalogProductsTable, catalogVariantsTable } from '../../catalog/schemas/products.schema.js';
import { catalogUnitsTable } from '../../catalog/schemas/units.schema.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import {
  purchaseInvoiceLinesTable,
  purchaseInvoicesTable,
  type PurchaseInvoiceRow,
} from '../schemas/receipts.schema.js';
import { suppliersTable } from '../schemas/suppliers.schema.js';
import type { Exec } from './stock.repository.js';

export async function insertInvoice(
  exec: Exec,
  data: {
    branch_id: number;
    supplier_id: number;
    number: string;
    supplier_invoice_no: string | null;
    invoice_date: Date;
    currency: 'SYP' | 'USD';
    exchange_rate: number | null;
    total_syp: number;
    total_usd: number;
    note: string | null;
  },
  userId: number,
): Promise<PurchaseInvoiceRow> {
  const rows = await exec
    .insert(purchaseInvoicesTable)
    .values({
      ...data,
      exchange_rate: data.exchange_rate === null ? null : String(data.exchange_rate),
      total_syp: String(data.total_syp),
      total_usd: String(data.total_usd),
      created_by_user_id: userId,
    })
    .returning();
  return rows[0]!;
}

export async function insertLines(
  exec: Exec,
  invoiceId: number,
  lines: {
    variant_id: number;
    unit_id: number;
    qty: number;
    factor: number;
    qty_base: number;
    unit_cost: number;
    unit_cost_base_syp: number;
    unit_cost_base_usd: number;
    expires_at: Date | null;
  }[],
): Promise<void> {
  await exec.insert(purchaseInvoiceLinesTable).values(
    lines.map((line) => ({
      invoice_id: invoiceId,
      variant_id: line.variant_id,
      unit_id: line.unit_id,
      qty: String(line.qty),
      factor: String(line.factor),
      qty_base: String(line.qty_base),
      unit_cost: String(line.unit_cost),
      unit_cost_base_syp: String(line.unit_cost_base_syp),
      unit_cost_base_usd: String(line.unit_cost_base_usd),
      expires_at: line.expires_at,
    })),
  );
}

export async function findById(id: number) {
  const rows = await db
    .select({
      invoice: purchaseInvoicesTable,
      supplier_name: suppliersTable.name,
      branch_name: branchesTable.name,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
    })
    .from(purchaseInvoicesTable)
    .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseInvoicesTable.supplier_id))
    .innerJoin(branchesTable, eq(branchesTable.id, purchaseInvoicesTable.branch_id))
    .leftJoin(usersTable, eq(usersTable.id, purchaseInvoicesTable.created_by_user_id))
    .where(eq(purchaseInvoicesTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findLines(invoiceId: number) {
  return db
    .select({
      variant_id: purchaseInvoiceLinesTable.variant_id,
      sku: catalogVariantsTable.sku,
      product_name_ar: catalogProductsTable.name_ar,
      unit_id: purchaseInvoiceLinesTable.unit_id,
      unit_name_ar: catalogUnitsTable.name_ar,
      qty: purchaseInvoiceLinesTable.qty,
      factor: purchaseInvoiceLinesTable.factor,
      qty_base: purchaseInvoiceLinesTable.qty_base,
      unit_cost: purchaseInvoiceLinesTable.unit_cost,
      unit_cost_base_syp: purchaseInvoiceLinesTable.unit_cost_base_syp,
      unit_cost_base_usd: purchaseInvoiceLinesTable.unit_cost_base_usd,
      expires_at: purchaseInvoiceLinesTable.expires_at,
    })
    .from(purchaseInvoiceLinesTable)
    .innerJoin(catalogVariantsTable, eq(catalogVariantsTable.id, purchaseInvoiceLinesTable.variant_id))
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .innerJoin(catalogUnitsTable, eq(catalogUnitsTable.id, purchaseInvoiceLinesTable.unit_id))
    .where(eq(purchaseInvoiceLinesTable.invoice_id, invoiceId));
}

export async function findMany(params: PaginationParams, filter: { branchId?: number; supplierId?: number }) {
  const conditions: SQL[] = [];
  if (filter.branchId !== undefined) conditions.push(eq(purchaseInvoicesTable.branch_id, filter.branchId));
  if (filter.supplierId !== undefined) conditions.push(eq(purchaseInvoicesTable.supplier_id, filter.supplierId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        invoice: purchaseInvoicesTable,
        supplier_name: suppliersTable.name,
        branch_name: branchesTable.name,
      })
      .from(purchaseInvoicesTable)
      .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseInvoicesTable.supplier_id))
      .innerJoin(branchesTable, eq(branchesTable.id, purchaseInvoicesTable.branch_id))
      .where(where)
      .orderBy(desc(purchaseInvoicesTable.created_at), desc(purchaseInvoicesTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ value: count() }).from(purchaseInvoicesTable).where(where),
  ]);
  return { rows, total: totalRows[0]?.value ?? 0 };
}
