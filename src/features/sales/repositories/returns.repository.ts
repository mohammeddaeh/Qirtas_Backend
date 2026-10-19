import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { saleLinesTable, salesTable } from '../schemas/sales.schema.js';
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
  goods_returns_enabled: boolean;
  print_returns_enabled: boolean;
  beyond_window_action: 'approve' | 'refuse';
  print_return_window_days: number | null;
  refund_cash_allowed: boolean;
  refund_credit_allowed: boolean;
  approval_above_syp: number | null;
  return_reason_required: boolean;
  damaged_returns_allowed: boolean;
  print_refund_suggest_percent: number;
  shift_reason_above_syp: number | null;
  shift_alert_hours: number;
  shift_stale_action: 'warn' | 'block';
  shift_cash_out_approval_syp: number | null;
  shift_review_above_syp: number | null;
  shift_denominations: number[];
}

type SettingsRow = typeof salesSettingsTable.$inferSelect;

function toSettings(row: SettingsRow): SalesSettings {
  return {
    return_window_days: row.return_window_days,
    reservation_hours: row.reservation_hours,
    goods_returns_enabled: row.goods_returns_enabled,
    print_returns_enabled: row.print_returns_enabled,
    // Anything but `refuse` reads as `approve` — today's behaviour.
    beyond_window_action: row.beyond_window_action === 'refuse' ? 'refuse' : 'approve',
    print_return_window_days: row.print_return_window_days,
    refund_cash_allowed: row.refund_cash_allowed,
    refund_credit_allowed: row.refund_credit_allowed,
    approval_above_syp: row.approval_above_syp === null ? null : Number(row.approval_above_syp),
    return_reason_required: row.return_reason_required,
    damaged_returns_allowed: row.damaged_returns_allowed,
    print_refund_suggest_percent: row.print_refund_suggest_percent,
    // The shift is always required (2026-10-19) — the old `shift_mode` column is no longer read.
    shift_reason_above_syp: row.shift_reason_above_syp === null ? null : Number(row.shift_reason_above_syp),
    shift_alert_hours: row.shift_alert_hours,
    // Anything but `block` reads as `warn` — a typo must not stop a branch taking money.
    shift_stale_action: row.shift_stale_action === 'block' ? 'block' : 'warn',
    shift_cash_out_approval_syp:
      row.shift_cash_out_approval_syp === null ? null : Number(row.shift_cash_out_approval_syp),
    shift_review_above_syp: row.shift_review_above_syp === null ? null : Number(row.shift_review_above_syp),
    shift_denominations: Array.isArray(row.shift_denominations)
      ? row.shift_denominations.filter((d): d is number => typeof d === 'number' && d > 0).sort((a, b) => a - b)
      : [],
  };
}

export async function findSettings(): Promise<SalesSettings> {
  const [row] = await db.select().from(salesSettingsTable).where(eq(salesSettingsTable.id, 1));
  if (row) return toSettings(row);
  await db.insert(salesSettingsTable).values({ id: 1 }).onConflictDoNothing();
  const [created] = await db.select().from(salesSettingsTable).where(eq(salesSettingsTable.id, 1));
  if (!created) throw new Error('sales_settings row missing');
  return toSettings(created);
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
  const merged = { ...current, ...values };
  const next = {
    ...merged,
    approval_above_syp: merged.approval_above_syp === null ? null : merged.approval_above_syp.toFixed(2),
    shift_reason_above_syp:
      merged.shift_reason_above_syp === null ? null : merged.shift_reason_above_syp.toFixed(2),
    shift_cash_out_approval_syp:
      merged.shift_cash_out_approval_syp === null ? null : merged.shift_cash_out_approval_syp.toFixed(2),
    shift_review_above_syp:
      merged.shift_review_above_syp === null ? null : merged.shift_review_above_syp.toFixed(2),
  };
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
    // A reprint hands the customer new copies — they still hold what they bought.
    .where(
      and(
        inArray(saleReturnLinesTable.sale_line_id, saleLineIds),
        sql`${saleReturnLinesTable.disposition} IS DISTINCT FROM 'reprint'`,
      ),
    )
    .groupBy(saleReturnLinesTable.sale_line_id);
  for (const row of rows) out.set(row.sale_line_id, Number(row.total));
  return out;
}

/** Money already paid back per sale line — the cap on the next refund. */
export async function findRefundedSyp(
  saleLineIds: number[],
  exec: Exec = db,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (saleLineIds.length === 0) return out;
  const rows = await exec
    .select({
      sale_line_id: saleReturnLinesTable.sale_line_id,
      total: sql<string>`COALESCE(SUM(${saleReturnLinesTable.refund_syp}), 0)`,
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
  const [row] = await db
    .select()
    .from(saleReturnsTable)
    .where(eq(saleReturnsTable.id, id))
    .limit(1);
  return row;
}

export async function findReturnLines(returnId: number) {
  return db
    .select()
    .from(saleReturnLinesTable)
    .where(eq(saleReturnLinesTable.return_id, returnId))
    .orderBy(saleReturnLinesTable.id);
}

/** Lines of many returns in one query — the returns list (2026-10-14). */
export async function findReturnLinesFor(returnIds: number[]) {
  const out = new Map<number, (typeof saleReturnLinesTable.$inferSelect)[]>();
  if (returnIds.length === 0) return out;
  const rows = await db
    .select()
    .from(saleReturnLinesTable)
    .where(inArray(saleReturnLinesTable.return_id, returnIds))
    .orderBy(saleReturnLinesTable.id);
  for (const r of rows) out.set(r.return_id, [...(out.get(r.return_id) ?? []), r]);
  return out;
}

/** The invoice numbers behind many returns — the list names the invoice, not its id. */
export async function findSaleNumbersFor(saleIds: number[]) {
  const out = new Map<number, string | null>();
  if (saleIds.length === 0) return out;
  const rows = await db
    .select({ id: salesTable.id, number: salesTable.number })
    .from(salesTable)
    .where(inArray(salesTable.id, saleIds));
  for (const r of rows) out.set(r.id, r.number);
  return out;
}

export async function findReturns(
  filters: {
    branchId?: number;
    saleId?: number;
    refundMethod?: 'cash' | 'customer_credit';
    sortBy?: 'created_at' | 'total';
    sortDir?: 'asc' | 'desc';
  },
  limit: number,
  offset: number,
): Promise<{ rows: SaleReturnRow[]; total: number }> {
  const dir = filters.sortDir === 'asc' ? asc : desc;
  const sortColumn = filters.sortBy === 'total' ? saleReturnsTable.total_syp : saleReturnsTable.created_at;
  const clauses = [];
  if (filters.refundMethod !== undefined)
    clauses.push(eq(saleReturnsTable.refund_method, filters.refundMethod));
  if (filters.branchId !== undefined)
    clauses.push(eq(saleReturnsTable.branch_id, filters.branchId));
  if (filters.saleId !== undefined) clauses.push(eq(saleReturnsTable.sale_id, filters.saleId));
  const where = clauses.length > 0 ? and(...clauses) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(saleReturnsTable)
      .where(where)
      .orderBy(dir(sortColumn), dir(saleReturnsTable.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<string>`count(*)` })
      .from(saleReturnsTable)
      .where(where),
  ]);
  return { rows, total: Number(counted[0]?.count ?? 0) };
}
