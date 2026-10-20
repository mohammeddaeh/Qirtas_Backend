import { and, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { purchaseInvoicesTable } from '../../inventory/schemas/receipts.schema.js';
import { purchaseReturnsTable } from '../../inventory/schemas/returns.schema.js';
import { suppliersTable } from '../../inventory/schemas/suppliers.schema.js';
import {
  supplierAllocationsTable,
  supplierConversionsTable,
  supplierPaymentsTable,
  type SupplierAllocationRow,
  type SupplierConversionRow,
  type SupplierPaymentRow,
} from '../schemas/payables.schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

/**
 * Reading what the shop owes its suppliers (`finance_operations.md` §٣). The
 * invoices, returns and suppliers are the inventory module's tables — read,
 * never written: a table is readable across modules, a service is not.
 */

export interface InvoiceRow {
  id: number;
  branchId: number;
  supplierId: number;
  number: string;
  supplierInvoiceNo: string | null;
  invoiceDate: Date;
  currency: 'SYP' | 'USD';
  rate: number | null;
  totalSyp: number;
  totalUsd: number;
}

/** Purchase invoices of real suppliers (the opening-balance one is the system's own). */
export async function findInvoices(filter: { supplierId?: number; branchId?: number; invoiceId?: number }): Promise<InvoiceRow[]> {
  const rows = await db
    .select({
      id: purchaseInvoicesTable.id,
      branchId: purchaseInvoicesTable.branch_id,
      supplierId: purchaseInvoicesTable.supplier_id,
      number: purchaseInvoicesTable.number,
      supplierInvoiceNo: purchaseInvoicesTable.supplier_invoice_no,
      invoiceDate: purchaseInvoicesTable.invoice_date,
      currency: purchaseInvoicesTable.currency,
      rate: purchaseInvoicesTable.exchange_rate,
      totalSyp: purchaseInvoicesTable.total_syp,
      totalUsd: purchaseInvoicesTable.total_usd,
    })
    .from(purchaseInvoicesTable)
    .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseInvoicesTable.supplier_id))
    .where(
      and(
        isNull(suppliersTable.system_key),
        filter.supplierId === undefined ? undefined : eq(purchaseInvoicesTable.supplier_id, filter.supplierId),
        filter.branchId === undefined ? undefined : eq(purchaseInvoicesTable.branch_id, filter.branchId),
        filter.invoiceId === undefined ? undefined : eq(purchaseInvoicesTable.id, filter.invoiceId),
      ),
    )
    .orderBy(purchaseInvoicesTable.invoice_date, purchaseInvoicesTable.id);
  return rows.map((r) => ({
    ...r,
    currency: r.currency === 'USD' ? 'USD' : 'SYP',
    rate: r.rate === null ? null : Number(r.rate),
    totalSyp: Number(r.totalSyp),
    totalUsd: Number(r.totalUsd),
  }));
}

/** Returned to the supplier, per invoice — at the invoice's cost in liras. */
export async function findReturnedByInvoice(invoiceIds: number[]): Promise<Map<number, number>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await db
    .select({ id: purchaseReturnsTable.receipt_id, total: sql<string>`sum(${purchaseReturnsTable.total_syp})` })
    .from(purchaseReturnsTable)
    .where(inArray(purchaseReturnsTable.receipt_id, invoiceIds))
    .groupBy(purchaseReturnsTable.receipt_id);
  return new Map(rows.map((r) => [r.id, Number(r.total)]));
}

export interface InvoiceSettled {
  paidUsd: number;
  paidSyp: number;
  gainSyp: number;
}

/** Settled so far per invoice and bucket — reversals are negative rows, so a sum is the truth. */
export async function findAllocatedByInvoice(exec: Exec, invoiceIds: number[]): Promise<Map<number, InvoiceSettled>> {
  const out = new Map<number, InvoiceSettled>();
  if (invoiceIds.length === 0) return out;
  const rows = await exec
    .select({
      id: supplierAllocationsTable.invoice_id,
      bucket: supplierAllocationsTable.bucket,
      total: sql<string>`sum(${supplierAllocationsTable.amount})`,
      gain: sql<string>`sum(${supplierAllocationsTable.fx_gain_syp})`,
    })
    .from(supplierAllocationsTable)
    .where(inArray(supplierAllocationsTable.invoice_id, invoiceIds))
    .groupBy(supplierAllocationsTable.invoice_id, supplierAllocationsTable.bucket);
  for (const r of rows) {
    if (r.id === null) continue;
    const s = out.get(r.id) ?? { paidUsd: 0, paidSyp: 0, gainSyp: 0 };
    if (r.bucket === 'USD') s.paidUsd += Number(r.total);
    else s.paidSyp += Number(r.total);
    s.gainSyp += Number(r.gain);
    out.set(r.id, s);
  }
  return out;
}

export interface InvoiceConverted {
  usd: number;
  syp: number;
  gainSyp: number;
}

export async function findConvertedByInvoice(exec: Exec, invoiceIds: number[]): Promise<Map<number, InvoiceConverted>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await exec
    .select({
      id: supplierConversionsTable.invoice_id,
      usd: sql<string>`sum(${supplierConversionsTable.amount_usd})`,
      syp: sql<string>`sum(${supplierConversionsTable.amount_syp})`,
      gain: sql<string>`sum(${supplierConversionsTable.fx_gain_syp})`,
    })
    .from(supplierConversionsTable)
    .where(inArray(supplierConversionsTable.invoice_id, invoiceIds))
    .groupBy(supplierConversionsTable.invoice_id);
  return new Map(rows.map((r) => [r.id, { usd: Number(r.usd), syp: Number(r.syp), gainSyp: Number(r.gain) }]));
}

/** Our credit with each supplier — payment money left unallocated, per currency. */
export async function findCredit(supplierIds: number[]): Promise<Map<number, { usd: number; syp: number }>> {
  const out = new Map<number, { usd: number; syp: number }>();
  if (supplierIds.length === 0) return out;
  const rows = await db
    .select({
      supplierId: supplierPaymentsTable.supplier_id,
      bucket: supplierAllocationsTable.bucket,
      total: sql<string>`sum(${supplierAllocationsTable.amount})`,
    })
    .from(supplierAllocationsTable)
    .innerJoin(supplierPaymentsTable, eq(supplierPaymentsTable.id, supplierAllocationsTable.payment_id))
    .where(and(isNull(supplierAllocationsTable.invoice_id), inArray(supplierPaymentsTable.supplier_id, supplierIds)))
    .groupBy(supplierPaymentsTable.supplier_id, supplierAllocationsTable.bucket);
  for (const r of rows) {
    const c = out.get(r.supplierId) ?? { usd: 0, syp: 0 };
    if (r.bucket === 'USD') c.usd += Number(r.total);
    else c.syp += Number(r.total);
    out.set(r.supplierId, c);
  }
  return out;
}

export async function findLastPaymentAt(supplierIds: number[]): Promise<Map<number, Date>> {
  if (supplierIds.length === 0) return new Map();
  const rows = await db
    .select({ supplierId: supplierPaymentsTable.supplier_id, last: sql<Date>`max(${supplierPaymentsTable.created_at})` })
    .from(supplierPaymentsTable)
    .where(and(inArray(supplierPaymentsTable.supplier_id, supplierIds), isNull(supplierPaymentsTable.reverses_payment_id)))
    .groupBy(supplierPaymentsTable.supplier_id);
  return new Map(rows.map((r) => [r.supplierId, new Date(r.last)]));
}

export async function findSuppliers(ids: number[], search?: string) {
  if (ids.length === 0) return [];
  return db
    .select({ id: suppliersTable.id, name: suppliersTable.name, phone: suppliersTable.phone })
    .from(suppliersTable)
    .where(and(inArray(suppliersTable.id, ids), search ? ilike(suppliersTable.search_text, `%${search}%`) : undefined));
}

export async function findSupplier(id: number) {
  const [row] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
  return row;
}

export async function findPayments(supplierId: number, branchId?: number, limit = 100): Promise<SupplierPaymentRow[]> {
  return db
    .select()
    .from(supplierPaymentsTable)
    .where(
      and(
        eq(supplierPaymentsTable.supplier_id, supplierId),
        branchId === undefined ? undefined : eq(supplierPaymentsTable.branch_id, branchId),
      ),
    )
    .orderBy(desc(supplierPaymentsTable.created_at), desc(supplierPaymentsTable.id))
    .limit(limit);
}

export async function findPayment(exec: Exec, id: number): Promise<SupplierPaymentRow | undefined> {
  const [row] = await exec.select().from(supplierPaymentsTable).where(eq(supplierPaymentsTable.id, id));
  return row;
}

export async function findReversalOf(exec: Exec, paymentId: number): Promise<SupplierPaymentRow | undefined> {
  const [row] = await exec
    .select()
    .from(supplierPaymentsTable)
    .where(eq(supplierPaymentsTable.reverses_payment_id, paymentId))
    .limit(1);
  return row;
}

export async function findAllocationsOf(exec: Exec, paymentIds: number[]): Promise<SupplierAllocationRow[]> {
  if (paymentIds.length === 0) return [];
  return exec.select().from(supplierAllocationsTable).where(inArray(supplierAllocationsTable.payment_id, paymentIds));
}

export async function findConversions(invoiceIds: number[]): Promise<SupplierConversionRow[]> {
  if (invoiceIds.length === 0) return [];
  return db
    .select()
    .from(supplierConversionsTable)
    .where(inArray(supplierConversionsTable.invoice_id, invoiceIds))
    .orderBy(desc(supplierConversionsTable.created_at));
}

export async function insertPayment(tx: Tx, values: typeof supplierPaymentsTable.$inferInsert): Promise<SupplierPaymentRow> {
  const [row] = await tx.insert(supplierPaymentsTable).values(values).returning();
  return row!;
}

export async function insertAllocations(tx: Tx, values: (typeof supplierAllocationsTable.$inferInsert)[]): Promise<void> {
  if (values.length > 0) await tx.insert(supplierAllocationsTable).values(values);
}

export async function insertConversion(tx: Tx, values: typeof supplierConversionsTable.$inferInsert): Promise<SupplierConversionRow> {
  const [row] = await tx.insert(supplierConversionsTable).values(values).returning();
  return row!;
}

/** Locks the invoices a payment will settle — two payers must not settle the same dollars twice. */
export async function lockInvoices(tx: Tx, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`SELECT id FROM purchase_invoices WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) FOR UPDATE`);
}
