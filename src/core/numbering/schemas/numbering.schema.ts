import { integer, pgTable, smallint, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * How each document type writes its number (`docs/reference/system_settings.md`
 * §الترقيم). One row per type; a missing row reads as the type's default, which
 * is exactly the shape that type used before this table existed.
 */
export const numberingFormatsTable = pgTable('numbering_formats', {
  doc_type: varchar('doc_type', { length: 20 }).primaryKey(),
  /** `R` in `MZ-R-2026-000010` — empty means no prefix segment. */
  prefix: varchar('prefix', { length: 4 }).notNull().default(''),
  /** `none` · `yyyy` · `yy` · `yymm` · `yymmdd` · `mmdd`. */
  date_format: varchar('date_format', { length: 8 }).notNull(),
  digits: smallint('digits').notNull(),
  updated_by: integer('updated_by'),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One counter per **stem** — the number without its sequence (`MZ-R-2026-`).
 *
 * Keyed by the rendered stem, not by (branch, type, year): two numbers that
 * share a stem share a counter, so no format change can ever issue a number
 * that already exists — and the counter restarts exactly when the date shown in
 * the number changes, which is what a reader of the number expects.
 */
export const docCountersTable = pgTable('doc_counters', {
  stem: varchar('stem', { length: 40 }).primaryKey(),
  last: integer('last').notNull().default(0),
});

export type NumberingFormatRow = typeof numberingFormatsTable.$inferSelect;
