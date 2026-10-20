import { and, asc, desc, eq, gte, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import { financeEntriesTable } from '../../core/finance/schemas/finance-entries.schema.js';
import { branchesTable } from '../identity/schemas/branches.schema.js';
import { usersTable } from '../identity/schemas/users.schema.js';
import { stockBalancesTable } from '../inventory/schemas/stock.schema.js';
import { printJobsTable } from '../printing/schemas/print-jobs.schema.js';
import { expensesTable, recurringExpensesTable } from '../sales/schemas/expenses.schema.js';
import { fxRatesTable } from '../sales/schemas/fx.schema.js';
import { cashShiftsTable } from '../sales/schemas/shifts.schema.js';
import { periodOf, recurringDue, todayIso } from '../sales/services/expense-rules.js';
import { figuresFrom } from './reports.service.js';

/**
 * The owner's day at a glance (`docs/reference/finance_operations.md` §٥) — one
 * call, every number from the server: the answer (net of the day and the same
 * weekday last week), each branch's drawer, the money that moved outside a sale,
 * and what needs attention, each a count that opens its place.
 *
 * Profit comes from {@link figuresFrom} — the very formula of the period report,
 * so the daily net and the report's net for one day cannot disagree.
 */

const n = (v: unknown): number => Math.round(Number(v ?? 0) * 100) / 100;

/** `YYYY-MM-DD` moved by [days] — whole calendar days, server time. */
export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayWindow(day: string): { start: Date; end: Date } {
  return { start: new Date(`${day}T00:00:00`), end: new Date(`${shiftDay(day, 1)}T00:00:00`) };
}

type Sums = { branch_id: number | null; type: string; method: string; total: number };

async function sumsOf(day: string): Promise<Sums[]> {
  const { start, end } = dayWindow(day);
  const rows = await db
    .select({
      branch_id: financeEntriesTable.branch_id,
      type: financeEntriesTable.type,
      method: financeEntriesTable.method,
      total: sql<string>`sum(${financeEntriesTable.amount_syp})`,
    })
    .from(financeEntriesTable)
    .where(and(gte(financeEntriesTable.occurred_at, start), lt(financeEntriesTable.occurred_at, end)))
    .groupBy(financeEntriesTable.branch_id, financeEntriesTable.type, financeEntriesTable.method);
  return rows.map((r) => ({ ...r, total: n(r.total) }));
}

/** The figures of one scope: every branch (`null`) or one. */
function scoped(rows: Sums[], branchId: number | null) {
  const mine = branchId === null ? rows : rows.filter((r) => r.branch_id === branchId);
  const byType = (type: string) => mine.filter((r) => r.type === type).reduce((s, r) => s + r.total, 0);
  const onAccount = mine
    .filter((r) => r.method === 'on_account' && (r.type === 'sale_revenue' || r.type === 'refund'))
    .reduce((s, r) => s + r.total, 0);
  return { f: figuresFrom(byType), newDebts: n(onAccount), debtsCollected: n(byType('debt_payment')), any: mine.length > 0 };
}

const name = (first: string | null, last: string | null) => [first, last].filter(Boolean).join(' ').trim() || null;

export async function dailySummary(day?: string) {
  const today = day ?? todayIso();
  const lastWeek = shiftDay(today, -7);
  const { start, end } = dayWindow(today);
  const [cur, prev, branches, openShifts, closedShifts, waiting, deferred, stock, recurring, recorded, fxRow] =
    await Promise.all([
      sumsOf(today),
      sumsOf(lastWeek),
      db
        .select({ id: branchesTable.id, name: branchesTable.name, code: branchesTable.code })
        .from(branchesTable)
        .where(isNull(branchesTable.archived_at))
        .orderBy(desc(branchesTable.is_default), asc(branchesTable.id)),
      // Open at the end of that day, whatever day it opened — a drawer left open
      // since yesterday is the point. Today's drawer is not yesterday's answer.
      db
        .select({
          id: cashShiftsTable.id,
          branch_id: cashShiftsTable.branch_id,
          number: cashShiftsTable.number,
          opened_at: cashShiftsTable.opened_at,
          first: usersTable.first_name,
          last: usersTable.last_name,
        })
        .from(cashShiftsTable)
        .leftJoin(usersTable, eq(usersTable.id, cashShiftsTable.cashier_user_id))
        .where(
          and(
            lt(cashShiftsTable.opened_at, end),
            or(isNull(cashShiftsTable.closed_at), gte(cashShiftsTable.closed_at, end)),
          ),
        ),
      db
        .select({
          id: cashShiftsTable.id,
          branch_id: cashShiftsTable.branch_id,
          number: cashShiftsTable.number,
          closed_at: cashShiftsTable.closed_at,
          difference_syp: cashShiftsTable.difference_syp,
          difference_usd: cashShiftsTable.difference_usd,
          needs_review: cashShiftsTable.needs_review,
          reviewed_at: cashShiftsTable.reviewed_at,
        })
        .from(cashShiftsTable)
        .where(and(eq(cashShiftsTable.status, 'closed'), gte(cashShiftsTable.closed_at, start), lt(cashShiftsTable.closed_at, end)))
        .orderBy(asc(cashShiftsTable.closed_at)),
      // Waiting for a review, any day — the list stays until someone looks.
      db
        .select({ branch_id: cashShiftsTable.branch_id, count: sql<number>`count(*)::int` })
        .from(cashShiftsTable)
        .where(and(eq(cashShiftsTable.needs_review, true), isNull(cashShiftsTable.reviewed_at)))
        .groupBy(cashShiftsTable.branch_id),
      // Printed before payment and not yet paid.
      db
        .select({
          branch_id: printJobsTable.branch_id,
          count: sql<number>`count(*)::int`,
          total: sql<string>`coalesce(sum(${printJobsTable.quoted_total_syp}), 0)`,
        })
        .from(printJobsTable)
        .where(and(eq(printJobsTable.payment_status, 'deferred'), notInArray(printJobsTable.status, ['cancelled', 'expired'])))
        .groupBy(printJobsTable.branch_id),
      // Out of stock by the inventory rule (`stockFlag`): nothing free, not below zero.
      db
        .select({ branch_id: stockBalancesTable.branch_id, count: sql<number>`count(*)::int` })
        .from(stockBalancesTable)
        .where(sql`${stockBalancesTable.on_hand} >= 0 AND ${stockBalancesTable.on_hand} - ${stockBalancesTable.reserved} <= 0`)
        .groupBy(stockBalancesTable.branch_id),
      db
        .select({
          id: recurringExpensesTable.id,
          branch_id: recurringExpensesTable.branch_id,
          amount_syp: recurringExpensesTable.amount_syp,
          day_of_month: recurringExpensesTable.day_of_month,
        })
        .from(recurringExpensesTable)
        .where(eq(recurringExpensesTable.is_active, true)),
      db
        .select({ id: expensesTable.recurring_id })
        .from(expensesTable)
        .where(
          and(
            sql`${expensesTable.recurring_id} IS NOT NULL`,
            isNull(expensesTable.reverses_expense_id),
            sql`NOT EXISTS (SELECT 1 FROM expenses r WHERE r.reverses_expense_id = ${expensesTable.id})`,
            eq(sql`to_char(${expensesTable.spent_on}, 'YYYY-MM')`, periodOf(today)),
          ),
        ),
      db.select().from(fxRatesTable).orderBy(desc(fxRatesTable.created_at), desc(fxRatesTable.id)).limit(1),
    ]);

  const recordedIds = new Set(recorded.map((r) => r.id));
  const dueRecurring = recurring.filter((r) => recurringDue(r.day_of_month, recordedIds.has(r.id), today));
  const now = new Date();
  // Open until now — or, for a past day, until that day ended.
  const until = now < end ? now : end;
  const hours = (from: Date) => Math.max(0, Math.floor((until.getTime() - from.getTime()) / 3_600_000));
  const countOf = (rows: { branch_id: number; count: number }[], id: number | null) =>
    rows.filter((r) => id === null || r.branch_id === id).reduce((s, r) => s + Number(r.count), 0);

  const attention = (id: number | null) => {
    const def = deferred.filter((r) => id === null || r.branch_id === id);
    const rec = dueRecurring.filter((r) => id === null || r.branch_id === id);
    return {
      shifts_waiting_review: countOf(waiting, id),
      deferred_prints: def.reduce((s, r) => s + Number(r.count), 0),
      deferred_prints_syp: n(def.reduce((s, r) => s + n(r.total), 0)),
      out_of_stock: countOf(stock, id),
      recurring_due: rec.length,
      recurring_due_syp: n(rec.reduce((s, r) => s + n(r.amount_syp), 0)),
    };
  };

  const answer = (id: number | null) => {
    const c = scoped(cur, id);
    const p = scoped(prev, id);
    return {
      c,
      out: {
        net_sales: c.f.net_sales,
        net_profit: c.f.net_profit,
        revenue: c.f.revenue,
        refunds: c.f.refunds,
        expenses: c.f.expenses,
        last_week: { day: lastWeek, net_sales: p.f.net_sales, net_profit: p.f.net_profit },
      },
      money: {
        expenses: c.f.expenses,
        supplier_payments: c.f.supplier_payments,
        new_debts: c.newDebts,
        debts_collected: c.debtsCollected,
      },
    };
  };

  const all = answer(null);
  const rows = branches.map((b) => {
    const a = answer(b.id);
    const open = openShifts.find((s) => s.branch_id === b.id);
    const closed = closedShifts.filter((s) => s.branch_id === b.id);
    const att = attention(b.id);
    return {
      branch_id: b.id,
      name: b.name,
      code: b.code,
      ...a.out,
      money: a.money,
      drawer: {
        open: open
          ? {
              shift_id: open.id,
              number: open.number,
              opened_at: open.opened_at.toISOString(),
              opened_by: name(open.first, open.last),
              hours_open: hours(open.opened_at),
              // Opened before this day began — a drawer nobody closed.
              since_before: open.opened_at < start,
            }
          : null,
        closed: closed.map((s) => ({
          shift_id: s.id,
          number: s.number,
          closed_at: s.closed_at?.toISOString() ?? null,
          difference_syp: n(s.difference_syp),
          difference_usd: n(s.difference_usd),
          waiting_review: s.needs_review && s.reviewed_at === null,
        })),
      },
      attention: att,
      // Something happened here that day — money moved or a drawer was worked. What
      // waits «now» (attention) is not that day's activity, so it does not count.
      active: a.c.any || open !== undefined || closed.length > 0,
    };
  });

  const fx = fxRow[0];
  const fxDays = fx ? Math.floor((dayWindow(today).start.getTime() - new Date(fx.created_at).setHours(0, 0, 0, 0)) / 86_400_000) : null;
  return {
    day: today,
    ...all.out,
    money: all.money,
    attention: attention(null),
    fx: fx
      ? {
          buy_rate: n(fx.buy_rate),
          sell_rate: n(fx.sell_rate),
          set_at: fx.created_at.toISOString(),
          // Decision §٨ #١١: a day without an update is worth a line.
          days_since: Math.max(0, fxDays ?? 0),
        }
      : null,
    branches: rows,
  };
}

