import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { recordFinance } from '../../../core/finance/finance-recorder.js';
import { BusinessError, ForbiddenError, NotFoundError } from '../../../core/http/api-error.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { SALES_AUDIT, saleTarget } from '../audit-actions.js';
import * as repo from '../repositories/expenses.repository.js';
import type { ExpenseRow } from '../schemas/expenses.schema.js';
import { periodOf, recurringDue, todayIso, wageDue, wageLeft, wageOn, type WageRow } from './expense-rules.js';
import { roundSyp } from './sale-rules.js';
import { drawerExpenseBack, drawerExpenseOut } from './shifts.service.js';

/**
 * Expenses and wages (`finance_operations.md` §٢). Every expense writes one
 * `expense` entry in the same transaction — from the drawer it goes through
 * the branch's open shift (cash, counted at the close); paid outside it is
 * `external` (real money, never counted in a drawer). Both lower net profit.
 * Nothing is edited: a mistake is undone by an opposite row.
 */

const MANAGE = 'expenses.manage';

export type ExpenseSource = 'drawer' | 'outside';

export interface ExpenseInput {
  branch_id: number;
  category_id: number;
  amount_syp: number;
  source: ExpenseSource;
  spent_on?: string;
  note?: string;
  receipt_media_id?: number;
  employee_user_id?: number;
  salary_kind?: 'salary' | 'advance';
  period?: string;
  recurring_id?: number;
}

function wireCategory(c: { id: number; name_ar: string; name_en: string | null; kind: string; is_active: boolean; sort_order: number }) {
  return { id: c.id, name_ar: c.name_ar, name_en: c.name_en, kind: c.kind, is_active: c.is_active, sort_order: c.sort_order };
}

export async function listCategories(includeInactive: boolean) {
  return (await repo.findCategories(includeInactive)).map(wireCategory);
}

export async function createCategory(actor: RequestActorContext, input: { name_ar: string; name_en?: string; kind: 'operating' | 'salary' }) {
  const row = await repo.insertCategory({ name_ar: input.name_ar.trim(), name_en: input.name_en?.trim() || null, kind: input.kind, sort_order: 50 });
  await recordAudit(actor, SALES_AUDIT.expenseCategory, saleTarget.expenseCategory(row.id), null, input);
  return wireCategory(row);
}

export async function updateCategory(
  actor: RequestActorContext,
  id: number,
  input: { name_ar?: string; name_en?: string | null; is_active?: boolean },
) {
  const before = await repo.findCategory(id);
  if (!before) throw new NotFoundError('Expense category not found');
  const row = await repo.updateCategory(id, {
    ...(input.name_ar === undefined ? {} : { name_ar: input.name_ar.trim() }),
    ...(input.name_en === undefined ? {} : { name_en: input.name_en?.trim() || null }),
    ...(input.is_active === undefined ? {} : { is_active: input.is_active }),
  });
  await recordAudit(actor, SALES_AUDIT.expenseCategory, saleTarget.expenseCategory(id), before, input);
  return wireCategory(row!);
}

async function wireExpenses(
  rows: Awaited<ReturnType<typeof repo.findExpenses>>['rows'],
) {
  const reversed = await repo.findReversedIds(rows.map((r) => r.e.id));
  const employees = await repo.findUserNames(
    rows.map((r) => r.e.employee_user_id).filter((id): id is number => id !== null),
  );
  return rows.map(({ e, ...r }) => ({
    id: e.id,
    branch_id: e.branch_id,
    branch_name: r.branch_name,
    category_id: e.category_id,
    category_name_ar: r.category_name_ar,
    category_name_en: r.category_name_en,
    category_kind: r.category_kind,
    amount_syp: Number(e.amount_syp),
    source: e.source,
    spent_on: e.spent_on,
    note: e.note,
    receipt_media_id: e.receipt_media_id,
    employee_user_id: e.employee_user_id,
    employee_name: e.employee_user_id === null ? null : (employees.get(e.employee_user_id) ?? null),
    salary_kind: e.salary_kind,
    period: e.period,
    recurring_id: e.recurring_id,
    shift_id: e.shift_id,
    reverses_expense_id: e.reverses_expense_id,
    reversed: reversed.has(e.id),
    created_by_name: r.created_by_name,
    created_at: e.created_at.toISOString(),
  }));
}

export async function listExpenses(f: repo.ExpensesFilter, page: number, limit: number) {
  const { rows, total } = await repo.findExpenses(f, limit, (page - 1) * limit);
  const totals = await repo.findExpenseTotals(f);
  return {
    items: await wireExpenses(rows),
    total,
    summary: {
      total_syp: roundSyp(totals.reduce((s, t) => s + Number(t.total), 0)),
      by_category: totals
        .map((t) => ({ category_id: t.category_id, name_ar: t.name_ar, name_en: t.name_en, kind: t.kind, total_syp: roundSyp(Number(t.total)) }))
        .filter((t) => t.total_syp !== 0),
    },
  };
}

/**
 * Records an expense. **From the drawer**: whoever sells at the branch, under
 * the cash-out cap (above it a manager approves — a manager at the branch is
 * their own approval), through the open shift. **Outside the drawer**:
 * `expenses.manage` at the branch. A wage names its employee and month.
 */
export async function createExpense(actor: RequestActorContext, input: ExpenseInput, approverUserId: number | null) {
  const category = await repo.findCategory(input.category_id);
  if (!category || !category.is_active) {
    throw new BusinessError(422, 'Pick an active category', 'expense_category_inactive');
  }
  const salary = category.kind === 'salary';
  if (salary && input.employee_user_id === undefined) {
    throw new BusinessError(422, 'A wage names the employee', 'expense_salary_needs_employee');
  }
  if (input.employee_user_id !== undefined && !(await repo.userExists(input.employee_user_id))) {
    throw new NotFoundError('Employee not found');
  }
  if (input.source === 'outside' && !(await holdsPermissionAt(actor.userId, MANAGE, input.branch_id))) {
    throw new ForbiddenError('Only an expenses manager records an expense paid outside the drawer', undefined, 'expense_outside_not_allowed');
  }
  const amount = roundSyp(input.amount_syp);
  const spentOn = input.spent_on ?? todayIso();
  const note = input.note?.trim() || null;
  const base = {
    branch_id: input.branch_id,
    category_id: input.category_id,
    amount_syp: String(amount),
    source: input.source,
    spent_on: spentOn,
    note,
    receipt_media_id: input.receipt_media_id ?? null,
    employee_user_id: salary ? (input.employee_user_id ?? null) : null,
    salary_kind: salary ? (input.salary_kind ?? 'salary') : null,
    period: salary ? (input.period ?? periodOf(spentOn)) : null,
    recurring_id: input.recurring_id ?? null,
    created_by_user_id: actor.userId,
    station_id: actor.stationId ?? null,
  };

  let created: ExpenseRow | undefined;
  if (input.source === 'drawer') {
    await drawerExpenseOut(actor, input.branch_id, amount, note ?? category.name_ar, approverUserId, async (tx, ref) => {
      created = await repo.insertExpense(tx, { ...base, cash_movement_id: ref.movementId, shift_id: ref.shiftId });
    });
  } else {
    await db.transaction(async (tx) => {
      created = await repo.insertExpense(tx, base);
      await recordFinance(tx, [
        {
          branchId: input.branch_id,
          type: 'expense',
          method: 'external',
          amountSyp: -amount,
          docType: 'expense',
          docId: created.id,
          userId: actor.userId,
          stationId: actor.stationId ?? null,
          reason: category.kind,
          note,
        },
      ]);
    });
  }
  await recordAudit(actor, SALES_AUDIT.expenseCreate, saleTarget.expense(created!.id), null, { ...input, approved_by: approverUserId });
  return getExpense(created!.id);
}

export async function getExpense(id: number) {
  const { rows } = await repo.findExpenses({ id }, 1, 0);
  const [wire] = await wireExpenses(rows);
  if (!wire) throw new NotFoundError('Expense not found');
  return wire;
}

/**
 * Undoes an expense — an opposite row, the original struck. From the drawer
 * the cash comes back into the branch's open shift.
 */
export async function reverseExpense(actor: RequestActorContext, id: number, reason: string) {
  let createdId = 0;
  await db.transaction(async (tx) => {
    const e = await repo.findExpense(id, tx);
    if (!e) throw new NotFoundError('Expense not found');
    if (!(await holdsPermissionAt(actor.userId, MANAGE, e.branch_id))) {
      throw new ForbiddenError('Only an expenses manager undoes an expense', undefined, 'expense_reverse_not_allowed');
    }
    if (e.reverses_expense_id !== null) throw new BusinessError(409, 'An undo cannot be undone', 'expense_is_reversal');
    if (await repo.findReversalOfExpense(id, tx)) throw new BusinessError(409, 'Already undone', 'expense_already_reversed');
    const amount = Number(e.amount_syp);
    const row = {
      branch_id: e.branch_id,
      category_id: e.category_id,
      amount_syp: String(-amount),
      source: e.source,
      spent_on: todayIso(),
      note: reason.trim(),
      employee_user_id: e.employee_user_id,
      salary_kind: e.salary_kind,
      period: e.period,
      reverses_expense_id: id,
      created_by_user_id: actor.userId,
      station_id: actor.stationId ?? null,
    };
    if (e.source === 'drawer') {
      const ref = await drawerExpenseBack(tx, actor, e.branch_id, amount, reason.trim(), e.cash_movement_id);
      createdId = (await repo.insertExpense(tx, { ...row, cash_movement_id: ref.movementId, shift_id: ref.shiftId })).id;
    } else {
      const created = await repo.insertExpense(tx, row);
      createdId = created.id;
      await recordFinance(tx, [
        {
          branchId: e.branch_id,
          type: 'expense',
          method: 'external',
          amountSyp: amount,
          docType: 'expense',
          docId: created.id,
          userId: actor.userId,
          stationId: actor.stationId ?? null,
          reason: 'reversal',
          note: reason.trim(),
        },
      ]);
    }
  });
  await recordAudit(actor, SALES_AUDIT.expenseReverse, saleTarget.expense(id), null, { reason, reversal_id: createdId });
  return getExpense(id);
}

// ── المتكرّر ────────────────────────────────────────────────────────────────

export async function listRecurring(includeInactive: boolean) {
  const today = todayIso();
  const recorded = await repo.findRecordedRecurring(periodOf(today));
  return (await repo.findRecurring(includeInactive)).map(({ r, ...x }) => ({
    id: r.id,
    branch_id: r.branch_id,
    branch_name: x.branch_name,
    category_id: r.category_id,
    category_name_ar: x.category_name_ar,
    category_name_en: x.category_name_en,
    amount_syp: Number(r.amount_syp),
    day_of_month: r.day_of_month,
    note: r.note,
    is_active: r.is_active,
    recorded_this_month: recorded.has(r.id),
    /** A reminder — recorded only when someone records it. */
    due: r.is_active && recurringDue(r.day_of_month, recorded.has(r.id), today),
  }));
}

export async function createRecurring(
  actor: RequestActorContext,
  input: { branch_id: number; category_id: number; amount_syp: number; day_of_month: number; note?: string },
) {
  const row = await repo.insertRecurring({
    branch_id: input.branch_id,
    category_id: input.category_id,
    amount_syp: String(roundSyp(input.amount_syp)),
    day_of_month: input.day_of_month,
    note: input.note?.trim() || null,
    created_by_user_id: actor.userId,
  });
  await recordAudit(actor, SALES_AUDIT.expenseRecurring, saleTarget.recurring(row.id), null, input);
  return (await listRecurring(true)).find((r) => r.id === row.id)!;
}

export async function updateRecurring(
  actor: RequestActorContext,
  id: number,
  input: { amount_syp?: number; day_of_month?: number; note?: string | null; is_active?: boolean },
) {
  const before = await repo.findRecurringById(id);
  if (!before) throw new NotFoundError('Recurring expense not found');
  await repo.updateRecurring(id, {
    ...(input.amount_syp === undefined ? {} : { amount_syp: String(roundSyp(input.amount_syp)) }),
    ...(input.day_of_month === undefined ? {} : { day_of_month: input.day_of_month }),
    ...(input.note === undefined ? {} : { note: input.note?.trim() || null }),
    ...(input.is_active === undefined ? {} : { is_active: input.is_active }),
  });
  await recordAudit(actor, SALES_AUDIT.expenseRecurring, saleTarget.recurring(id), before, input);
  return (await listRecurring(true)).find((r) => r.id === id)!;
}

// ── الأجور ──────────────────────────────────────────────────────────────────

type WageDbRow = Awaited<ReturnType<typeof repo.findWageRows>>[number];

const asRule = (r: WageDbRow['w']): WageRow & { id: number } => ({
  id: r.id,
  amount: Number(r.amount_syp),
  frequency: r.frequency,
  dueDay: r.due_day,
  effectiveFrom: r.effective_from,
  endedOn: r.ended_on,
});

/**
 * Every employee with a wage: the wage today, what was paid this month (wage
 * and advances), what is left of a monthly wage, and whether it is due.
 */
export async function listWages(branchId: number | undefined) {
  const today = todayIso();
  const period = periodOf(today);
  const rows = await repo.findWageRows();
  const byUser = new Map<number, WageDbRow[]>();
  for (const r of rows) {
    const list = byUser.get(r.w.user_id) ?? [];
    list.push(r);
    byUser.set(r.w.user_id, list);
  }
  const ids = [...byUser.keys()];
  const [paid, last] = await Promise.all([repo.findPaidInPeriod(period, ids), repo.findLastPayments(ids)]);
  const out = [];
  for (const [userId, list] of byUser) {
    const rules = list.map((r) => asRule(r.w));
    const current = wageOn(rules, today);
    const row = current === null ? list[list.length - 1]! : list.find((r) => r.w.id === current.id)!;
    if (branchId !== undefined && row.w.branch_id !== branchId) continue;
    const paidNow = roundSyp(paid.get(userId) ?? 0);
    out.push({
      user_id: userId,
      user_name: row.user_name,
      branch_id: row.w.branch_id,
      branch_name: row.branch_name,
      /** `null` = no wage today (ended, or starting later). */
      amount_syp: current?.amount ?? null,
      frequency: row.w.frequency,
      due_day: row.w.due_day,
      effective_from: row.w.effective_from,
      ended_on: row.w.ended_on,
      period,
      paid_this_period_syp: paidNow,
      left_syp: wageLeft(current, paidNow),
      due: wageDue(current, paidNow, today),
      last_paid_on: last.get(userId) ?? null,
    });
  }
  return out.sort((a, b) => Number(b.due) - Number(a.due) || (a.user_name ?? '').localeCompare(b.user_name ?? ''));
}

export async function wageHistory(userId: number) {
  return (await repo.findWageRows(userId)).map(({ w, branch_name }) => ({
    id: w.id,
    branch_id: w.branch_id,
    branch_name,
    amount_syp: Number(w.amount_syp),
    frequency: w.frequency,
    due_day: w.due_day,
    effective_from: w.effective_from,
    ended_on: w.ended_on,
    note: w.note,
  }));
}

/** A new wage from its day — the old row stays as history. */
export async function setWage(
  actor: RequestActorContext,
  userId: number,
  input: { branch_id: number; amount_syp: number; frequency: 'monthly' | 'weekly' | 'daily'; due_day: number; effective_from?: string; note?: string },
) {
  if (!(await repo.userExists(userId))) throw new NotFoundError('Employee not found');
  await repo.insertWage({
    user_id: userId,
    branch_id: input.branch_id,
    amount_syp: String(roundSyp(input.amount_syp)),
    frequency: input.frequency,
    due_day: input.due_day,
    effective_from: input.effective_from ?? todayIso(),
    note: input.note?.trim() || null,
    created_by_user_id: actor.userId,
  });
  await recordAudit(actor, SALES_AUDIT.wageSet, saleTarget.wage(userId), null, input);
  return wageHistory(userId);
}

/** No wage from this day — the person left, or is no longer paid here. */
export async function endWage(actor: RequestActorContext, userId: number, endedOn: string | undefined) {
  const rows = await repo.findWageRows(userId);
  const day = endedOn ?? todayIso();
  const current = wageOn(rows.map((r) => asRule(r.w)), day);
  if (current === null) throw new BusinessError(409, 'No wage to end', 'wage_none');
  await repo.endWageRow(current.id, day);
  await recordAudit(actor, SALES_AUDIT.wageSet, saleTarget.wage(userId), null, { ended_on: day });
  return wageHistory(userId);
}
