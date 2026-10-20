import { boolean, date, index, integer, numeric, pgEnum, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';

/**
 * المصاريف والرواتب — `docs/reference/finance_operations.md` §٢.
 *
 * **في موديول المبيعات** لأن المصروف من الدرج يمرّ بوردية الفرع نفسها كالسداد:
 * قبضٌ وصرفٌ من درجٍ واحد بقاعدةٍ واحدة (الوردية · سقف الإخراج · موافقة المدير)،
 * وموديولٌ ثانٍ كان سيحتاج نسخةً من تلك القواعد أو منفذاً لكلٍّ منها.
 *
 * **ولا تعديل ولا حذف**: الخطأ يُعكس بصفٍّ مقابل والأصل يبقى مشطوباً.
 */

/** `salary` categories carry an employee; `operating` the rest — both lower net profit. */
export const expenseCategoryKindEnum = pgEnum('expense_category_kind', ['operating', 'salary']);
/** From the branch drawer (through its open shift) or paid outside it (the owner, a bank). */
export const expenseSourceEnum = pgEnum('expense_source', ['drawer', 'outside']);
/** A wage payment, or an advance taken against the next one. */
export const salaryKindEnum = pgEnum('salary_kind', ['salary', 'advance']);
export const wageFrequencyEnum = pgEnum('wage_frequency', ['monthly', 'weekly', 'daily']);

export const expenseCategoriesTable = pgTable('expense_categories', {
  id: serial('id').primaryKey(),
  name_ar: varchar('name_ar', { length: 80 }).notNull(),
  name_en: varchar('name_en', { length: 80 }),
  kind: expenseCategoryKindEnum('kind').notNull().default('operating'),
  is_active: boolean('is_active').notNull().default(true),
  sort_order: integer('sort_order').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const expensesTable = pgTable(
  'expenses',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    category_id: integer('category_id')
      .notNull()
      .references(() => expenseCategoriesTable.id, { onDelete: 'restrict' }),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    source: expenseSourceEnum('source').notNull(),
    /** The day it was spent — a rent paid late is still that month's. */
    spent_on: date('spent_on').notNull(),
    note: text('note'),
    /** A photo of the receipt (`media`), optional. */
    receipt_media_id: integer('receipt_media_id'),
    /** Whose wage — on a salary category only. */
    employee_user_id: integer('employee_user_id').references(() => usersTable.id, { onDelete: 'restrict' }),
    salary_kind: salaryKindEnum('salary_kind'),
    /** The month a wage is for, `2026-10` — what «paid this month» is read from. */
    period: varchar('period', { length: 7 }),
    /** The reminder it answered, when recorded from one. */
    recurring_id: integer('recurring_id'),
    /** From the drawer: the cash movement and the shift it went through. */
    cash_movement_id: integer('cash_movement_id'),
    shift_id: integer('shift_id'),
    /** Set on the row that undoes another. */
    reverses_expense_id: integer('reverses_expense_id'),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    station_id: integer('station_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    branchDayIdx: index('expenses_branch_day_idx').on(table.branch_id, table.spent_on),
    employeeIdx: index('expenses_employee_idx').on(table.employee_user_id, table.period),
  }),
);

/** A monthly bill (rent, internet) — **a reminder, never recorded by itself** (decision §٨ #٦). */
export const recurringExpensesTable = pgTable('recurring_expenses', {
  id: serial('id').primaryKey(),
  branch_id: integer('branch_id')
    .notNull()
    .references(() => branchesTable.id, { onDelete: 'restrict' }),
  category_id: integer('category_id')
    .notNull()
    .references(() => expenseCategoriesTable.id, { onDelete: 'restrict' }),
  amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
  /** 1–28: every month has it. */
  day_of_month: integer('day_of_month').notNull(),
  note: text('note'),
  is_active: boolean('is_active').notNull().default(true),
  created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An employee's wage (decision §٨ #٧) — **a row per change**, from its day: a
 * raise in March does not rewrite what January paid. The wage today is the
 * latest row started on or before today, unless it was ended.
 */
export const employeeWagesTable = pgTable(
  'employee_wages',
  {
    id: serial('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    frequency: wageFrequencyEnum('frequency').notNull().default('monthly'),
    /** Day of the month the monthly wage falls due (1–28). */
    due_day: integer('due_day').notNull().default(1),
    effective_from: date('effective_from').notNull(),
    /** No wage from this day — the person left, or is no longer paid here. */
    ended_on: date('ended_on'),
    note: text('note'),
    created_by_user_id: integer('created_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('employee_wages_user_idx').on(table.user_id, table.effective_from),
  }),
);

export type ExpenseRow = typeof expensesTable.$inferSelect;
export type ExpenseCategoryRow = typeof expenseCategoriesTable.$inferSelect;
export type RecurringExpenseRow = typeof recurringExpensesTable.$inferSelect;
export type EmployeeWageRow = typeof employeeWagesTable.$inferSelect;
