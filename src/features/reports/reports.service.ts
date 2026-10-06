import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import { financeEntriesTable } from '../../core/finance/schemas/finance-entries.schema.js';
import { branchesTable } from '../identity/schemas/branches.schema.js';
import { usersTable } from '../identity/schemas/users.schema.js';
import { printReadyCopiesTable } from '../printing/schemas/print-ready.schema.js';
import { saleReturnLinesTable, saleReturnsTable } from '../sales/schemas/returns.schema.js';
import { saleLinesTable, salesTable } from '../sales/schemas/sales.schema.js';

/**
 * Financial reports (`docs/reference/finance_ledger.md` §٥, M-3) — **every number
 * is a sum of ledger entries**, so a report and the books cannot disagree.
 *
 * Profit rules (§٢): gross profit = net sales + cost of goods (signed, its
 * reversal included) + print materials + the cost of ready copies sold. Losses
 * are named apart (damaged returns · damaged prints · ready write-offs ·
 * inventory · print waste) and net profit = gross profit + losses. The ready
 * shelf's value is an asset as of the period's end, never profit.
 */

export interface ReportQuery {
  branchId?: number;
  /** Inclusive day `YYYY-MM-DD`. */
  from: string;
  /** Inclusive day `YYYY-MM-DD`. */
  to: string;
}

const LOSS_TYPES = [
  'loss_damaged_return',
  'loss_print_return',
  'loss_ready_writeoff',
  'loss_inventory',
  'print_waste',
] as const;

const COST_TYPES = ['cogs', 'cogs_reversal', 'print_materials', 'ready_shelf_out'] as const;

const n = (v: unknown): number => Math.round(Number(v ?? 0) * 100) / 100;

/** `[from 00:00, to+1 00:00)` in server time — whole days, the last one included. */
function window(q: ReportQuery): { start: Date; end: Date } {
  const start = new Date(`${q.from}T00:00:00`);
  const end = new Date(`${q.to}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function ledgerScope(q: ReportQuery): SQL | undefined {
  const { start, end } = window(q);
  return and(
    gte(financeEntriesTable.occurred_at, start),
    lt(financeEntriesTable.occurred_at, end),
    q.branchId ? eq(financeEntriesTable.branch_id, q.branchId) : undefined,
  );
}

async function sumsByType(q: ReportQuery): Promise<Map<string, number>> {
  const rows = await db
    .select({ type: financeEntriesTable.type, total: sql<string>`sum(${financeEntriesTable.amount_syp})` })
    .from(financeEntriesTable)
    .where(ledgerScope(q))
    .groupBy(financeEntriesTable.type);
  return new Map(rows.map((r) => [r.type, n(r.total)]));
}

export async function summary(q: ReportQuery) {
  const { start, end } = window(q);
  const branchSql = q.branchId ? eq(financeEntriesTable.branch_id, q.branchId) : undefined;
  const [byType, byMethod, byCashier, lossByReason, shelfRow, printLines, printRefunds, branches] = await Promise.all([
    sumsByType(q),
    db
      .select({
        type: financeEntriesTable.type,
        method: financeEntriesTable.method,
        total: sql<string>`sum(${financeEntriesTable.amount_syp})`,
      })
      .from(financeEntriesTable)
      .where(and(ledgerScope(q), inArray(financeEntriesTable.type, ['sale_revenue', 'refund'])))
      .groupBy(financeEntriesTable.type, financeEntriesTable.method),
    db
      .select({
        user_id: financeEntriesTable.user_id,
        first: usersTable.first_name,
        last: usersTable.last_name,
        type: financeEntriesTable.type,
        method: financeEntriesTable.method,
        total: sql<string>`sum(${financeEntriesTable.amount_syp})`,
      })
      .from(financeEntriesTable)
      .leftJoin(usersTable, eq(usersTable.id, financeEntriesTable.user_id))
      .where(and(ledgerScope(q), inArray(financeEntriesTable.type, ['sale_revenue', 'refund'])))
      .groupBy(financeEntriesTable.user_id, usersTable.first_name, usersTable.last_name, financeEntriesTable.type, financeEntriesTable.method),
    db
      .select({
        type: financeEntriesTable.type,
        reason: financeEntriesTable.reason,
        total: sql<string>`sum(${financeEntriesTable.amount_syp})`,
        count: sql<number>`count(*)`,
      })
      .from(financeEntriesTable)
      .where(and(ledgerScope(q), inArray(financeEntriesTable.type, [...LOSS_TYPES])))
      .groupBy(financeEntriesTable.type, financeEntriesTable.reason),
    // The shelf as of the period's end — an asset, counted from the beginning.
    db
      .select({ total: sql<string>`coalesce(sum(${financeEntriesTable.amount_syp}), 0)` })
      .from(financeEntriesTable)
      .where(
        and(
          lt(financeEntriesTable.occurred_at, end),
          branchSql,
          inArray(financeEntriesTable.type, ['ready_shelf_in', 'ready_shelf_out', 'loss_ready_writeoff']),
        ),
      ),
    // Print revenue by kind — the ledger books revenue per invoice, so the
    // split comes from the paid invoices' print lines.
    db
      .select({ kind: saleLinesTable.service_kind, total: sql<string>`sum(${saleLinesTable.line_total_syp})` })
      .from(saleLinesTable)
      .innerJoin(salesTable, eq(salesTable.id, saleLinesTable.sale_id))
      .where(
        and(
          eq(salesTable.status, 'paid'),
          gte(salesTable.paid_at, start),
          lt(salesTable.paid_at, end),
          q.branchId ? eq(salesTable.branch_id, q.branchId) : undefined,
          sql`${saleLinesTable.service_kind} IS NOT NULL`,
        ),
      )
      .groupBy(saleLinesTable.service_kind),
    db
      .select({ total: sql<string>`coalesce(sum(${saleReturnLinesTable.refund_syp}), 0)` })
      .from(saleReturnLinesTable)
      .innerJoin(saleReturnsTable, eq(saleReturnsTable.id, saleReturnLinesTable.return_id))
      .where(
        and(
          gte(saleReturnsTable.created_at, start),
          lt(saleReturnsTable.created_at, end),
          q.branchId ? eq(saleReturnsTable.branch_id, q.branchId) : undefined,
          sql`${saleReturnLinesTable.service_kind} IS NOT NULL`,
        ),
      ),
    db
      .select({ id: branchesTable.id, name: branchesTable.name, code: branchesTable.code })
      .from(branchesTable)
      .where(isNull(branchesTable.archived_at))
      .orderBy(desc(branchesTable.is_default), asc(branchesTable.id)),
  ]);

  const t = (k: string) => byType.get(k) ?? 0;
  const revenue = t('sale_revenue');
  const refunds = -t('refund');
  const netSales = n(revenue - refunds);
  const costs = COST_TYPES.reduce((s, k) => s + t(k), 0);
  const grossProfit = n(netSales + costs);
  const losses = LOSS_TYPES.reduce((s, k) => s + t(k), 0);
  const methodTotal = (type: string, method: string) =>
    n(byMethod.filter((r) => r.type === type && r.method === method).reduce((s, r) => s + n(r.total), 0));

  const cashiers = new Map<string, { user_id: number | null; name: string; revenue: number; refunds: number; cash: number }>();
  for (const r of byCashier) {
    const key = String(r.user_id ?? 0);
    const row = cashiers.get(key) ?? {
      user_id: r.user_id,
      name: [r.first, r.last].filter(Boolean).join(' ').trim(),
      revenue: 0,
      refunds: 0,
      cash: 0,
    };
    const v = n(r.total);
    if (r.type === 'sale_revenue') row.revenue = n(row.revenue + v);
    else row.refunds = n(row.refunds - v);
    if (r.method === 'cash') row.cash = n(row.cash + v);
    cashiers.set(key, row);
  }

  const printRevenue = (kind: string) => n(printLines.find((r) => r.kind === kind)?.total);

  return {
    period: { from: q.from, to: q.to },
    branch_id: q.branchId ?? null,
    branches,
    summary: {
      revenue: n(revenue),
      refunds: n(refunds),
      net_sales: netSales,
      cost_of_sales: n(-costs),
      gross_profit: grossProfit,
      losses: n(-losses),
      net_profit: n(grossProfit + losses),
      ready_shelf_value: n(shelfRow[0]?.total),
      // Cash that should be in the drawers: cash taken minus cash paid back.
      expected_cash: n(methodTotal('sale_revenue', 'cash') + methodTotal('refund', 'cash')),
    },
    revenue_by_method: ['cash', 'card', 'customer_credit', 'on_account'].map((m) => ({
      method: m,
      revenue: methodTotal('sale_revenue', m),
      refunds: n(-methodTotal('refund', m)),
    })),
    cashiers: [...cashiers.values()].sort((a, b) => b.revenue - a.revenue),
    printing: {
      revenue_new: n(printRevenue('print_job') + printRevenue('print_counter')),
      revenue_ready: printRevenue('print_ready'),
      materials: n(-t('print_materials')),
      waste: n(-t('print_waste')),
      refunds: n(printRefunds[0]?.total),
    },
    ready_shelf: {
      taken_in: n(t('ready_shelf_in')),
      sold_cost: n(-t('ready_shelf_out')),
      written_off: n(-t('loss_ready_writeoff')),
      value_now: n(shelfRow[0]?.total),
      sales_revenue: printRevenue('print_ready'),
    },
    losses: lossByReason
      .map((r) => ({ type: r.type, reason: r.reason, amount: n(-n(r.total)), count: Number(r.count) }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/** The entries behind one loss line — each names its document. */
export async function lossEntries(q: ReportQuery & { type?: string }, limit: number, offset: number) {
  const where = and(
    ledgerScope(q),
    q.type ? eq(financeEntriesTable.type, q.type as (typeof LOSS_TYPES)[number]) : inArray(financeEntriesTable.type, [...LOSS_TYPES]),
  );
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: financeEntriesTable.id,
        type: financeEntriesTable.type,
        amount: financeEntriesTable.amount_syp,
        reason: financeEntriesTable.reason,
        note: financeEntriesTable.note,
        doc_type: financeEntriesTable.doc_type,
        doc_id: financeEntriesTable.doc_id,
        sale_id: financeEntriesTable.sale_id,
        branch_id: financeEntriesTable.branch_id,
        occurred_at: financeEntriesTable.occurred_at,
        first: usersTable.first_name,
        last: usersTable.last_name,
        sale_number: salesTable.number,
        ready_number: printReadyCopiesTable.number,
        ready_label: printReadyCopiesTable.label,
      })
      .from(financeEntriesTable)
      .leftJoin(usersTable, eq(usersTable.id, financeEntriesTable.user_id))
      .leftJoin(salesTable, eq(salesTable.id, financeEntriesTable.sale_id))
      .leftJoin(
        printReadyCopiesTable,
        and(eq(financeEntriesTable.doc_type, 'ready_copy'), eq(printReadyCopiesTable.id, financeEntriesTable.doc_id)),
      )
      .where(where)
      .orderBy(desc(financeEntriesTable.occurred_at), desc(financeEntriesTable.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(financeEntriesTable).where(where),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: n(-n(r.amount)),
      reason: r.reason,
      note: r.note,
      doc_type: r.doc_type,
      doc_id: r.doc_id,
      sale_id: r.sale_id,
      sale_number: r.sale_number,
      ready_number: r.ready_number,
      ready_label: r.ready_label,
      branch_id: r.branch_id,
      user_name: [r.first, r.last].filter(Boolean).join(' ').trim() || null,
      occurred_at: r.occurred_at.toISOString(),
    })),
    total: Number(count?.n ?? 0),
  };
}

