import { boolean, index, integer, numeric, pgEnum, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';

/**
 * الوردية — `docs/reference/cash_shifts.md`.
 *
 * **درج الفرع** (قرار 2026-10-19، يحلّ محلّ «للكاشير»): في كل فرع درجٌ واحد
 * يضع فيه الجميع المال — الكاشير والمدير من الموبايل وموظف المطبوعات. فورديةٌ
 * مفتوحة واحدة **لكل فرع**، وكل من يقبض يقبض عليها، وكل قيدٍ باسم صاحبه وجهازه.
 *
 * **المتوقَّع مجموع قيود الوردية** (`finance_entries.shift_id`) لا حساباً
 * بالتاريخ: بيعٌ بعد منتصف الليل في ورديةٍ بدأت مساءً يبقى فيها. ويُحفظ بالصفّ
 * لحظة الإقفال فلا يتغيّر تقريرٌ أُقفل لأن قيداً تأخّر.
 */
export const shiftStatusEnum = pgEnum('cash_shift_status', ['open', 'closed']);
export const cashMovementDirectionEnum = pgEnum('cash_movement_direction', ['in', 'out']);

export const cashShiftsTable = pgTable(
  'cash_shifts',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    /** Who opened the branch's drawer — kept under its first name; the drawer is the branch's. */
    cashier_user_id: integer('cashier_user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    number: varchar('number', { length: 40 }).notNull(),
    sequence: integer('sequence').notNull(),
    status: shiftStatusEnum('status').notNull().default('open'),
    opened_at: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    /** The computer it was opened at — `null` from a phone. */
    opened_station_id: integer('opened_station_id'),
    /** What the last close left in this drawer — `null` when nothing was left on record. */
    opening_suggested_syp: numeric('opening_suggested_syp', { precision: 14, scale: 2 }),
    /** What the opener counted — the base of the expected cash. */
    opening_counted_syp: numeric('opening_counted_syp', { precision: 14, scale: 2 }).notNull(),
    closed_at: timestamp('closed_at', { withTimezone: true }),
    closed_by_user_id: integer('closed_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    closed_station_id: integer('closed_station_id'),
    /** A manager counted the drawer for an absent cashier. */
    closed_on_behalf: boolean('closed_on_behalf').notNull().default(false),
    /** The blind count. */
    counted_syp: numeric('counted_syp', { precision: 14, scale: 2 }),
    /** Left in the drawer for the next opening; the rest went to the safe. */
    left_in_drawer_syp: numeric('left_in_drawer_syp', { precision: 14, scale: 2 }),
    /** Frozen at close. */
    expected_syp: numeric('expected_syp', { precision: 14, scale: 2 }),
    /** counted − expected: positive over, negative short. */
    difference_syp: numeric('difference_syp', { precision: 14, scale: 2 }),
    /** Whether the close crossed the threshold that asks for a reason. */
    reason_required: boolean('reason_required').notNull().default(false),
    /** The reason as a code the reports group by: `change_error` · `unrecorded_expense` · `count_error` · `other`. */
    reason_code: varchar('reason_code', { length: 30 }),
    /** The free note — required with `other`. */
    reason: text('reason'),
    /** The difference passed the review threshold — on the manager's list until someone reviews it. */
    needs_review: boolean('needs_review').notNull().default(false),
    reviewed_by_user_id: integer('reviewed_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => ({
    branchOpenedIdx: index('cash_shifts_branch_opened_idx').on(table.branch_id, table.opened_at),
    cashierIdx: index('cash_shifts_cashier_idx').on(table.cashier_user_id),
    /** One open shift per branch — one drawer. The server's own guard, not the screen's. */
    oneOpen: uniqueIndex('cash_shifts_branch_one_open_uq')
      .on(table.branch_id)
      .where(sql`${table.status} = 'open'`),
  }),
);

/** Cash put into or taken out of the drawer by hand — always with a reason. */
export const cashMovementsTable = pgTable(
  'cash_movements',
  {
    id: serial('id').primaryKey(),
    shift_id: integer('shift_id')
      .notNull()
      .references(() => cashShiftsTable.id, { onDelete: 'restrict' }),
    direction: cashMovementDirectionEnum('direction').notNull(),
    amount_syp: numeric('amount_syp', { precision: 14, scale: 2 }).notNull(),
    /** A code the screen translates: `safe_drop` · `float_top_up` · `expense` · `other`. */
    reason_code: varchar('reason_code', { length: 30 }).notNull(),
    note: text('note'),
    user_id: integer('user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    station_id: integer('station_id'),
    /** The movement this one undoes — a wrong movement is reversed, never edited or deleted. */
    reverses_movement_id: integer('reverses_movement_id'),
    /** The manager who approved a cash-out above the cap. */
    approved_by_user_id: integer('approved_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    shiftIdx: index('cash_movements_shift_idx').on(table.shift_id),
  }),
);

export type CashShiftRow = typeof cashShiftsTable.$inferSelect;
export type CashMovementRow = typeof cashMovementsTable.$inferSelect;
