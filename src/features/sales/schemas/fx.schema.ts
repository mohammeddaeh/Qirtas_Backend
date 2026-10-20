import { index, integer, numeric, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { usersTable } from '../../identity/schemas/users.schema.js';

/**
 * The dollar's two rates — `docs/reference/finance_operations.md` §٣-ب.
 *
 * **A log, not a value**: every change is a new row, so «what was the rate on
 * the 3rd?» has an answer and a record keeps the rate it was booked at. The
 * current rate is the newest row.
 *
 * - **buy**: the shop takes a dollar and gives liras (a customer paying in dollars).
 * - **sell**: the shop gives a dollar.
 *
 * The catalog's pricing rate (shelf prices in dollars) stays its own setting.
 */
export const fxRatesTable = pgTable(
  'fx_rates',
  {
    id: serial('id').primaryKey(),
    buy_rate: numeric('buy_rate', { precision: 14, scale: 4 }).notNull(),
    sell_rate: numeric('sell_rate', { precision: 14, scale: 4 }).notNull(),
    note: text('note'),
    set_by_user_id: integer('set_by_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdIdx: index('fx_rates_created_idx').on(table.created_at),
  }),
);

export type FxRateRow = typeof fxRatesTable.$inferSelect;
