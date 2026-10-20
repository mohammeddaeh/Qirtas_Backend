/**
 * Finance reference data — the expense categories (`finance_operations.md` §٢).
 *
 * Migration 0063 inserted them once; the showcase wipe empties the table, and
 * an expense screen without categories cannot record anything. Insert-if-empty,
 * so categories an admin added or renamed survive every re-run.
 *
 * Invoked by the orchestrator in `seed.ts`; never opens or closes the pool.
 */
import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { logger } from '../logger/logger.js';

const CATEGORIES: [string, string, 'operating' | 'salary', number][] = [
  ['إيجار', 'Rent', 'operating', 1],
  ['رواتب وأجور', 'Salaries & wages', 'salary', 2],
  ['كهرباء وماء', 'Electricity & water', 'operating', 3],
  ['إنترنت واتصالات', 'Internet & phone', 'operating', 4],
  ['نقل ومواصلات', 'Transport', 'operating', 5],
  ['صيانة', 'Maintenance', 'operating', 6],
  ['ضيافة', 'Hospitality', 'operating', 7],
  ['قرطاسية المحل', 'Shop supplies', 'operating', 8],
  ['أخرى', 'Other', 'operating', 99],
];

export async function seedFinanceReference(): Promise<void> {
  const existing = (await db.execute<{ n: number }>(sql`select count(*)::int as n from expense_categories`)).rows[0]?.n ?? 0;
  if (existing > 0) return;
  for (const [ar, en, kind, order] of CATEGORIES) {
    await db.execute(
      sql`insert into expense_categories (name_ar, name_en, kind, sort_order) values (${ar}, ${en}, ${kind}, ${order})`,
    );
  }
  logger.info({ categories: CATEGORIES.length }, 'Expense categories seeded');
}
