import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { saleLinesTable } from '../schemas/sales.schema.js';
import {
  returnSequencesTable,
  saleReturnLinesTable,
  saleReturnsTable,
  salesSettingsTable,
  type SaleReturnRow,
} from '../schemas/returns.schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

// ── الإعدادات ───────────────────────────────────────────────────────────────

/**
 * الصفّ الواحد — **ويُنشأ بأول قراءة**.
 *
 * بلا ذلك تعود المهلة `null` حتى يفتح أحدٌ شاشة الإعدادات، فيُرفض كل إرجاع
 * بيومٍ افتتاحي لأن أحداً لم يزر شاشةً لا يعرف بوجودها.
 */
export interface SalesSettings {
  return_window_days: number;
  reservation_hours: number;
}

export async function findSettings(): Promise<SalesSettings> {
  const [row] = await db.select().from(salesSettingsTable).where(eq(salesSettingsTable.id, 1));
  if (row) {
    return { return_window_days: row.return_window_days, reservation_hours: row.reservation_hours };
  }
  await db.insert(salesSettingsTable).values({ id: 1 }).onConflictDoNothing();
  const [created] = await db.select().from(salesSettingsTable).where(eq(salesSettingsTable.id, 1));
  return {
    return_window_days: created?.return_window_days ?? 14,
    reservation_hours: created?.reservation_hours ?? 48,
  };
}

/**
 * **الحقل الغائب يبقى كما هو.**
 *
 * حفظٌ يكتب كل الحقول من جسمٍ ناقص يُعيد مهلة الحجز لافتراضها كلّما عدّل أحدهم
 * مهلة الإرجاع — بلا خطأ، وبلا ما يقول إن قيمةً أخرى تغيّرت.
 */
export async function saveSettings(
  values: Partial<SalesSettings>,
  userId: number | null,
): Promise<void> {
  const current = await findSettings();
  const next = { ...current, ...values };
  await db
    .insert(salesSettingsTable)
    .values({ id: 1, ...next, updated_by: userId })
    .onConflictDoUpdate({
      target: salesSettingsTable.id,
      set: { ...next, updated_by: userId, updated_at: new Date() },
    });
}

// ── ما أُرجع سابقاً ─────────────────────────────────────────────────────────

/**
 * المُرجَع لكل سطر بيع — **أساس السقف**.
 *
 * حسابُه من المرتجعات نفسها لا من عمودٍ على السطر: عمودٌ يُحدَّث يفقد التطابق
 * أول مرة يُكتب مرتجعٌ ولا يُحدَّث هو، والقطعة تُرجع مرتين بلا أن يفشل شيء.
 */
export async function findReturnedQty(
  saleLineIds: number[],
  exec: Exec = db,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (saleLineIds.length === 0) return out;
  const rows = await exec
    .select({
      sale_line_id: saleReturnLinesTable.sale_line_id,
      total: sql<string>`COALESCE(SUM(${saleReturnLinesTable.qty}), 0)`,
    })
    .from(saleReturnLinesTable)
    .where(inArray(saleReturnLinesTable.sale_line_id, saleLineIds))
    .groupBy(saleReturnLinesTable.sale_line_id);
  for (const row of rows) out.set(row.sale_line_id, Number(row.total));
  return out;
}

/** أسطر البيع **مقفلة** — بينها وبين كتابة المرتجع لا يُرجع أحدٌ القطعة نفسها. */
export async function lockSaleLines(exec: Exec, saleId: number) {
  const rows = await exec.execute(
    sql`SELECT * FROM ${saleLinesTable} WHERE ${saleLinesTable.sale_id} = ${saleId} FOR UPDATE`,
  );
  const list =
    (rows as unknown as { rows?: (typeof saleLinesTable.$inferSelect)[] }).rows ??
    (rows as unknown as (typeof saleLinesTable.$inferSelect)[]);
  return list;
}

// ── المرتجع ─────────────────────────────────────────────────────────────────

export async function nextReturnSequence(
  exec: Exec,
  branchId: number,
  year: number,
): Promise<number> {
  const result = await exec.execute(
    sql`INSERT INTO ${returnSequencesTable} (branch_id, year, last_sequence)
        VALUES (${branchId}, ${year}, 1)
        ON CONFLICT (branch_id, year)
        DO UPDATE SET last_sequence = ${returnSequencesTable}.last_sequence + 1
        RETURNING last_sequence`,
  );
  const list =
    (result as unknown as { rows?: { last_sequence: number }[] }).rows ??
    (result as unknown as { last_sequence: number }[]);
  return Number(list[0]?.last_sequence ?? 1);
}

export async function insertReturn(
  exec: Exec,
  values: typeof saleReturnsTable.$inferInsert,
): Promise<SaleReturnRow> {
  const [row] = await exec.insert(saleReturnsTable).values(values).returning();
  return row!;
}

export async function insertReturnLines(
  exec: Exec,
  rows: (typeof saleReturnLinesTable.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(saleReturnLinesTable).values(rows);
}

export async function findReturnById(id: number): Promise<SaleReturnRow | undefined> {
  const [row] = await db.select().from(saleReturnsTable).where(eq(saleReturnsTable.id, id)).limit(1);
  return row;
}

export async function findReturnLines(returnId: number) {
  return db
    .select()
    .from(saleReturnLinesTable)
    .where(eq(saleReturnLinesTable.return_id, returnId))
    .orderBy(saleReturnLinesTable.id);
}

export async function findReturns(
  filters: { branchId?: number; saleId?: number },
  limit: number,
  offset: number,
): Promise<{ rows: SaleReturnRow[]; total: number }> {
  const clauses = [];
  if (filters.branchId !== undefined) clauses.push(eq(saleReturnsTable.branch_id, filters.branchId));
  if (filters.saleId !== undefined) clauses.push(eq(saleReturnsTable.sale_id, filters.saleId));
  const where = clauses.length > 0 ? and(...clauses) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(saleReturnsTable)
      .where(where)
      .orderBy(desc(saleReturnsTable.created_at), desc(saleReturnsTable.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<string>`count(*)` }).from(saleReturnsTable).where(where),
  ]);
  return { rows, total: Number(counted[0]?.count ?? 0) };
}
