import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import {
  employeeWagesTable,
  expenseCategoriesTable,
  expensesTable,
  recurringExpensesTable,
} from '../schemas/expenses.schema.js';
import type { Exec } from './sales.repository.js';

const fullName = (t: typeof usersTable) =>
  sql<string | null>`NULLIF(TRIM(CONCAT(${t.first_name}, ' ', ${t.last_name})), '')`;

// ── التصنيفات ───────────────────────────────────────────────────────────────

export async function findCategories(includeInactive: boolean) {
  return db
    .select()
    .from(expenseCategoriesTable)
    .where(includeInactive ? undefined : eq(expenseCategoriesTable.is_active, true))
    .orderBy(asc(expenseCategoriesTable.sort_order), asc(expenseCategoriesTable.id));
}

export async function findCategory(id: number) {
  const [row] = await db.select().from(expenseCategoriesTable).where(eq(expenseCategoriesTable.id, id)).limit(1);
  return row;
}

export async function insertCategory(values: typeof expenseCategoriesTable.$inferInsert) {
  const [row] = await db.insert(expenseCategoriesTable).values(values).returning();
  return row!;
}

export async function updateCategory(id: number, values: Partial<typeof expenseCategoriesTable.$inferInsert>) {
  const [row] = await db.update(expenseCategoriesTable).set(values).where(eq(expenseCategoriesTable.id, id)).returning();
  return row;
}

// ── المصاريف ────────────────────────────────────────────────────────────────

export interface ExpensesFilter {
  id?: number;
  branchId?: number;
  categoryId?: number;
  employeeId?: number;
  from?: string;
  /** Exclusive. */
  to?: string;
}

function expensesWhere(f: ExpensesFilter): SQL | undefined {
  const c: SQL[] = [];
  if (f.id !== undefined) c.push(eq(expensesTable.id, f.id));
  if (f.branchId !== undefined) c.push(eq(expensesTable.branch_id, f.branchId));
  if (f.categoryId !== undefined) c.push(eq(expensesTable.category_id, f.categoryId));
  if (f.employeeId !== undefined) c.push(eq(expensesTable.employee_user_id, f.employeeId));
  if (f.from !== undefined) c.push(gte(expensesTable.spent_on, f.from));
  if (f.to !== undefined) c.push(lt(expensesTable.spent_on, f.to));
  return c.length > 0 ? and(...c) : undefined;
}

const creator = usersTable;

export async function findExpenses(f: ExpensesFilter, limit: number, offset: number) {
  const where = expensesWhere(f);
  const rows = await db
    .select({
      e: expensesTable,
      category_name_ar: expenseCategoriesTable.name_ar,
      category_name_en: expenseCategoriesTable.name_en,
      category_kind: expenseCategoriesTable.kind,
      branch_name: branchesTable.name,
      created_by_name: fullName(creator),
    })
    .from(expensesTable)
    .innerJoin(expenseCategoriesTable, eq(expenseCategoriesTable.id, expensesTable.category_id))
    .innerJoin(branchesTable, eq(branchesTable.id, expensesTable.branch_id))
    .leftJoin(creator, eq(creator.id, expensesTable.created_by_user_id))
    .where(where)
    .orderBy(desc(expensesTable.spent_on), desc(expensesTable.id))
    .limit(limit)
    .offset(offset);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(expensesTable).where(where);
  return { rows, total: count?.n ?? 0 };
}

/** The total and the share of each category — reversals are negative rows, so a sum nets them. */
export async function findExpenseTotals(f: ExpensesFilter) {
  return db
    .select({
      category_id: expenseCategoriesTable.id,
      name_ar: expenseCategoriesTable.name_ar,
      name_en: expenseCategoriesTable.name_en,
      kind: expenseCategoriesTable.kind,
      total: sql<string>`SUM(${expensesTable.amount_syp})`,
    })
    .from(expensesTable)
    .innerJoin(expenseCategoriesTable, eq(expenseCategoriesTable.id, expensesTable.category_id))
    .where(expensesWhere(f))
    .groupBy(expenseCategoriesTable.id, expenseCategoriesTable.name_ar, expenseCategoriesTable.name_en, expenseCategoriesTable.kind)
    .orderBy(asc(expenseCategoriesTable.sort_order));
}

/** Names of the employees on these rows. */
export async function findUserNames(ids: number[]) {
  if (ids.length === 0) return new Map<number, string>();
  const rows = await db.select({ id: usersTable.id, name: fullName(usersTable) }).from(usersTable).where(inArray(usersTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name ?? `#${r.id}`]));
}

export async function findExpense(id: number, exec: Exec = db) {
  const [row] = await exec.select().from(expensesTable).where(eq(expensesTable.id, id)).limit(1);
  return row;
}

export async function findReversalOfExpense(id: number, exec: Exec = db) {
  const [row] = await exec.select({ id: expensesTable.id }).from(expensesTable).where(eq(expensesTable.reverses_expense_id, id)).limit(1);
  return row;
}

export async function findReversedIds(ids: number[]) {
  if (ids.length === 0) return new Set<number>();
  const rows = await db
    .select({ id: expensesTable.reverses_expense_id })
    .from(expensesTable)
    .where(inArray(expensesTable.reverses_expense_id, ids));
  return new Set(rows.map((r) => r.id!).filter((id) => id !== null));
}

export async function insertExpense(exec: Exec, values: typeof expensesTable.$inferInsert) {
  const [row] = await exec.insert(expensesTable).values(values).returning();
  return row!;
}

/** What each employee was paid (wage + advances) in a month. */
export async function findPaidInPeriod(period: string, userIds: number[]) {
  if (userIds.length === 0) return new Map<number, number>();
  const rows = await db
    .select({ user: expensesTable.employee_user_id, total: sql<string>`SUM(${expensesTable.amount_syp})` })
    .from(expensesTable)
    .where(and(eq(expensesTable.period, period), inArray(expensesTable.employee_user_id, userIds)))
    .groupBy(expensesTable.employee_user_id);
  return new Map(rows.map((r) => [r.user!, Number(r.total)]));
}

export async function findLastPayments(userIds: number[]) {
  if (userIds.length === 0) return new Map<number, string>();
  const rows = await db
    .select({ user: expensesTable.employee_user_id, last: sql<string>`MAX(${expensesTable.spent_on})` })
    .from(expensesTable)
    .where(and(inArray(expensesTable.employee_user_id, userIds), isNull(expensesTable.reverses_expense_id)))
    .groupBy(expensesTable.employee_user_id);
  return new Map(rows.map((r) => [r.user!, r.last]));
}

/** Which reminders were answered this month. */
export async function findRecordedRecurring(period: string) {
  const rows = await db
    .select({ id: expensesTable.recurring_id })
    .from(expensesTable)
    .where(and(sql`${expensesTable.recurring_id} IS NOT NULL`, eq(sql`to_char(${expensesTable.spent_on}, 'YYYY-MM')`, period)));
  return new Set(rows.map((r) => r.id!));
}

// ── المتكرّر ────────────────────────────────────────────────────────────────

export async function findRecurring(includeInactive: boolean) {
  return db
    .select({
      r: recurringExpensesTable,
      category_name_ar: expenseCategoriesTable.name_ar,
      category_name_en: expenseCategoriesTable.name_en,
      branch_name: branchesTable.name,
    })
    .from(recurringExpensesTable)
    .innerJoin(expenseCategoriesTable, eq(expenseCategoriesTable.id, recurringExpensesTable.category_id))
    .innerJoin(branchesTable, eq(branchesTable.id, recurringExpensesTable.branch_id))
    .where(includeInactive ? undefined : eq(recurringExpensesTable.is_active, true))
    .orderBy(asc(recurringExpensesTable.day_of_month), asc(recurringExpensesTable.id));
}

export async function findRecurringById(id: number) {
  const [row] = await db.select().from(recurringExpensesTable).where(eq(recurringExpensesTable.id, id)).limit(1);
  return row;
}

export async function insertRecurring(values: typeof recurringExpensesTable.$inferInsert) {
  const [row] = await db.insert(recurringExpensesTable).values(values).returning();
  return row!;
}

export async function updateRecurring(id: number, values: Partial<typeof recurringExpensesTable.$inferInsert>) {
  const [row] = await db.update(recurringExpensesTable).set(values).where(eq(recurringExpensesTable.id, id)).returning();
  return row;
}

// ── الأجور ──────────────────────────────────────────────────────────────────

/** Every wage row, oldest first, with the employee's and the branch's names. */
export async function findWageRows(userId?: number) {
  return db
    .select({
      w: employeeWagesTable,
      user_name: fullName(usersTable),
      branch_name: branchesTable.name,
    })
    .from(employeeWagesTable)
    .innerJoin(usersTable, eq(usersTable.id, employeeWagesTable.user_id))
    .innerJoin(branchesTable, eq(branchesTable.id, employeeWagesTable.branch_id))
    .where(userId === undefined ? undefined : eq(employeeWagesTable.user_id, userId))
    .orderBy(asc(employeeWagesTable.effective_from), asc(employeeWagesTable.id));
}

export async function insertWage(values: typeof employeeWagesTable.$inferInsert) {
  const [row] = await db.insert(employeeWagesTable).values(values).returning();
  return row!;
}

export async function endWageRow(id: number, endedOn: string) {
  await db.update(employeeWagesTable).set({ ended_on: endedOn }).where(eq(employeeWagesTable.id, id));
}

export async function userExists(id: number) {
  const [row] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  return row !== undefined;
}
