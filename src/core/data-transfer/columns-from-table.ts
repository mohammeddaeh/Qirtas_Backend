import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { ColumnDef, ColumnType, LocalizedLabel } from './types.js';

/**
 * Derives a resource's columns from its **drizzle table**, so type and
 * requiredness follow the schema instead of being retyped by hand.
 *
 * ```ts
 * columns: columnsFromTable(branchesTable, {
 *   id:           { ar: 'المعرّف',    en: 'ID' },
 *   name:         { ar: 'اسم الفرع',  en: 'Branch name', example: 'فرع الكورنيش' },
 *   address:      { ar: 'العنوان',    en: 'Address' },
 *   created_at:   { ar: 'أنشئ',       en: 'Created at' },
 * }, { importable: ['name', 'address'] }),
 * ```
 *
 * ## What it removes, and what it deliberately does not
 *
 * It removes the two things that rot: `type` and `required`. Widening a column
 * from `integer` to `numeric`, or dropping a `NOT NULL`, previously left a hand-
 * written `type: 'number'` / `required: true` behind with nothing to catch it —
 * and the symptom was an importer refusing rows the database would have taken.
 * Here the schema is the single source, checked at boot.
 *
 * It does **not** enumerate the table for you. You still list every key you want
 * transferred, because the alternative — export everything by default — is how a
 * password hash, an internal flag or a soft-delete marker ends up in a
 * spreadsheet somebody emails. Opting a column in must be a decision somebody
 * made, and the label they have to write is that decision.
 *
 * `importable` is likewise explicit: a column being writable in the database
 * says nothing about whether a spreadsheet should set it.
 */
export interface ColumnSpec extends Partial<LocalizedLabel> {
  ar: string;
  en: string;
  /** Overrides the type derived from the table. Rarely needed — an enum column stored as text but shown as a fixed set, for instance. */
  type?: ColumnType;
  /** Overrides requiredness derived from the table's `NOT NULL` / default. */
  required?: boolean;

  /** A sample **value**, written into the template's example row. Teaches the format. */
  example?: string;

  /** One line on what the column **means**, shown in the app. Never written to a file. */
  hintAr?: string;
  hintEn?: string;
}

export interface ColumnsFromTableOptions {
  /**
   * Keys a file may set. Everything else is export-only.
   *
   * Absent means **nothing is importable** — an export-only resource. That is
   * the safe direction to be wrong in: a missing entry produces a column the
   * importer ignores, not one it silently accepts.
   */
  importable?: string[];
}

/** Maps a drizzle column's SQL type onto the closed set the client can render. */
function toColumnType(dataType: string, columnType: string): ColumnType {
  if (dataType === 'boolean') return 'boolean';
  if (dataType === 'number' || dataType === 'bigint') return 'number';
  if (dataType === 'date') {
    // `PgTimestamp` carries a time; `PgDate` does not. The distinction decides
    // whether the exporter writes `2026-08-12` or a full ISO instant, and
    // whether the importer accepts a bare date.
    return columnType === 'PgDate' ? 'date' : 'datetime';
  }
  // Everything else — text, varchar, uuid, enum, numeric-as-string — is text to
  // the file. `numeric` is deliberately here: Postgres returns it as a string
  // to preserve precision, and treating it as a JS number would round money.
  return 'string';
}

export function columnsFromTable(
  table: PgTable,
  labels: Record<string, ColumnSpec>,
  options: ColumnsFromTableOptions = {},
): ColumnDef[] {
  const tableColumns = getTableColumns(table);
  const importable = new Set(options.importable ?? []);

  const unknown = Object.keys(labels).filter((key) => !(key in tableColumns));
  if (unknown.length > 0) {
    // At boot, not on the first request. A key that no longer exists on the
    // table is a rename nobody finished, and it would otherwise surface as a
    // column of empty cells in an export somebody sends to a colleague.
    throw new Error(
      `columnsFromTable: no such column(s) on the table: ${unknown.join(', ')}`,
    );
  }

  const notOnTable = [...importable].filter((key) => !(key in labels));
  if (notOnTable.length > 0) {
    throw new Error(
      `columnsFromTable: importable names a column that was never labelled: ${notOnTable.join(', ')}`,
    );
  }

  return Object.entries(labels).map(([key, spec]) => {
    const column = tableColumns[key]!;

    return {
      key,
      label: { ar: spec.ar, en: spec.en },
      type: spec.type ?? toColumnType(column.dataType, column.columnType),
      // Required means "the file must supply it": NOT NULL **and** no default.
      // A `NOT NULL DEFAULT now()` column is not something a user has to fill
      // in, and demanding it would make every template unusable.
      required:
        spec.required ??
        (importable.has(key) && column.notNull && !column.hasDefault),
      importable: importable.has(key),
      ...(spec.example !== undefined ? { example: spec.example } : {}),
      // Both languages or neither: a hint in one language is unreadable to half
      // the users, and the client has no fallback to apply.
      ...(spec.hintAr !== undefined && spec.hintEn !== undefined
        ? { hint: { ar: spec.hintAr, en: spec.hintEn } }
        : {}),
    };
  });
}
