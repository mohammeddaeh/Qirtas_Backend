import { and, asc, count, eq, ilike, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import { purchaseInvoicesTable } from '../schemas/receipts.schema.js';
import { suppliersTable, type NewSupplierRow, type SupplierRow } from '../schemas/suppliers.schema.js';

export function findMany(
  params: PaginationParams,
  filter: { search?: string; archived: boolean },
): Promise<{ rows: SupplierRow[]; total: number }> {
  const conditions: SQL[] = [filter.archived ? isNotNull(suppliersTable.archived_at) : isNull(suppliersTable.archived_at)];
  if (filter.search) conditions.push(ilike(suppliersTable.search_text, `%${filter.search}%`));
  return findManyPaginated<SupplierRow>(suppliersTable, params, {
    where: and(...conditions),
    orderBy: asc(suppliersTable.name),
  });
}

export function findById(id: number): Promise<SupplierRow | undefined> {
  return findOneById<SupplierRow>(suppliersTable, suppliersTable.id, id);
}

export async function findBySearchText(searchText: string): Promise<SupplierRow | undefined> {
  const rows = await db.select().from(suppliersTable).where(eq(suppliersTable.search_text, searchText)).limit(1);
  return rows[0];
}

export async function insert(data: NewSupplierRow): Promise<SupplierRow> {
  const rows = await db.insert(suppliersTable).values(data).returning();
  return rows[0]!;
}

export async function update(id: number, data: Partial<NewSupplierRow>): Promise<SupplierRow | undefined> {
  const rows = await db
    .update(suppliersTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(suppliersTable.id, id))
    .returning();
  return rows[0];
}

export async function hardDelete(id: number): Promise<void> {
  await db.delete(suppliersTable).where(eq(suppliersTable.id, id));
}

/** Invoices ever received from this supplier — what decides delete vs archive. */
export async function countInvoices(supplierId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(purchaseInvoicesTable)
    .where(eq(purchaseInvoicesTable.supplier_id, supplierId));
  return row?.value ?? 0;
}
