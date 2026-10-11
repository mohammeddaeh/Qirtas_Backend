import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { printJobsTable } from '../schemas/print-jobs.schema.js';
import {
  printPrintersTable,
  type NewPrintPrinterRow,
  type PrintPrinterRow,
} from '../schemas/print-printers.schema.js';

/** A branch's printers (9-ط-2) — active first, in the order the branch set. */
export function findByBranch(branchId: number, activeOnly = false): Promise<PrintPrinterRow[]> {
  return db
    .select()
    .from(printPrintersTable)
    .where(
      and(
        eq(printPrintersTable.branch_id, branchId),
        activeOnly ? eq(printPrintersTable.is_active, true) : undefined,
      ),
    )
    .orderBy(asc(printPrintersTable.sort_order), asc(printPrintersTable.id));
}

export async function findById(id: number): Promise<PrintPrinterRow | undefined> {
  const [row] = await db.select().from(printPrintersTable).where(eq(printPrintersTable.id, id));
  return row;
}

export async function findNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: printPrintersTable.id, name: printPrintersTable.name })
    .from(printPrintersTable)
    .where(inArray(printPrintersTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function insert(row: NewPrintPrinterRow): Promise<PrintPrinterRow> {
  const [created] = await db.insert(printPrintersTable).values(row).returning();
  return created!;
}

export async function update(
  id: number,
  patch: Partial<Pick<PrintPrinterRow, 'name' | 'supports_color' | 'is_active' | 'sort_order'>>,
): Promise<PrintPrinterRow | undefined> {
  const [row] = await db
    .update(printPrintersTable)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(printPrintersTable.id, id))
    .returning();
  return row;
}

export async function remove(id: number): Promise<void> {
  await db.delete(printPrintersTable).where(eq(printPrintersTable.id, id));
}

/** Whether any job ever went through it — then it is stopped, not deleted. */
export async function isUsed(id: number): Promise<boolean> {
  const [row] = await db
    .select({ id: printJobsTable.id })
    .from(printJobsTable)
    .where(eq(printJobsTable.printer_id, id))
    .limit(1);
  return row !== undefined;
}
