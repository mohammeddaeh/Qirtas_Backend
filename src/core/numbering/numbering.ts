import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { docCountersTable, numberingFormatsTable } from './schemas/numbering.schema.js';

/**
 * Document numbering, central (`docs/reference/system_settings.md` §الترقيم).
 *
 * `[branch code]-[prefix]-[date]-[sequence]`, each segment optional except the
 * code and the sequence. In `core/` because sales, printing and inventory all
 * issue numbers; the caller passes the branch code (core never reads features).
 */

export const DOC_TYPES = [
  'sale',
  'sale_return',
  'order',
  'print_job',
  'receipt',
  'purchase_return',
  'adjustment',
  'transfer',
  'count',
  'ready_copy',
  'pickup',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DATE_FORMATS = ['none', 'yyyy', 'yy', 'yymm', 'yymmdd', 'mmdd'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface NumberingFormat {
  prefix: string;
  date_format: DateFormat;
  digits: number;
}

/** Each type's default = the shape it had before numbering became a setting. */
export const DEFAULT_FORMATS: Record<DocType, NumberingFormat> = {
  sale: { prefix: '', date_format: 'yyyy', digits: 6 },
  sale_return: { prefix: 'R', date_format: 'yyyy', digits: 6 },
  order: { prefix: 'O', date_format: 'yyyy', digits: 6 },
  print_job: { prefix: 'P', date_format: 'yyyy', digits: 6 },
  receipt: { prefix: 'GRN', date_format: 'none', digits: 6 },
  purchase_return: { prefix: 'PRT', date_format: 'none', digits: 6 },
  adjustment: { prefix: 'DMG', date_format: 'none', digits: 6 },
  transfer: { prefix: 'TRF', date_format: 'none', digits: 6 },
  count: { prefix: 'CNT', date_format: 'none', digits: 6 },
  ready_copy: { prefix: 'J', date_format: 'none', digits: 4 },
  /** `1005-042` — written by hand on a copy; the date makes yesterday's 042 a different code. */
  pickup: { prefix: '', date_format: 'mmdd', digits: 3 },
};

/**
 * Types shown **without** the branch code (`printing_system.md` §9-ز). The
 * counter still runs per branch — the code stays in the counter's key — but the
 * number is written on paper and looked up inside one branch, so the code is
 * only length. And they share no prefix with documents: `1005-042` cannot be
 * read as an invoice number.
 */
export const CODELESS_TYPES: readonly DocType[] = ['pickup'];

function shown(docType: DocType, number: string, code: string): string {
  return CODELESS_TYPES.includes(docType) && number.startsWith(`${code}-`) ? number.slice(code.length + 1) : number;
}

/** A barcode on 58 mm paper starts to crowd past this (with a 6-letter code). */
export const MAX_NUMBER_LENGTH = 24;
export const LONGEST_CODE = 'ABCDEF';

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

export function datePart(format: DateFormat, at: Date): string {
  const yyyy = String(at.getFullYear());
  const yy = yyyy.slice(2);
  const mm = pad(at.getMonth() + 1, 2);
  const dd = pad(at.getDate(), 2);
  switch (format) {
    case 'none':
      return '';
    case 'yyyy':
      return yyyy;
    case 'yy':
      return yy;
    case 'yymm':
      return yy + mm;
    case 'yymmdd':
      return yy + mm + dd;
    case 'mmdd':
      return mm + dd;
  }
}

/** The number without its sequence — the counter's key. Ends with `-`. */
export function stemOf(format: NumberingFormat, code: string, at: Date): string {
  const parts = [code, format.prefix, datePart(format.date_format, at)].filter((p) => p.length > 0);
  return `${parts.join('-')}-`;
}

export function render(format: NumberingFormat, code: string, at: Date, sequence: number): string {
  return stemOf(format, code, at) + pad(sequence, format.digits);
}

/** Why a format is refused — a message key, or null when it is fine. */
export function formatProblem(
  docType: DocType,
  format: NumberingFormat,
  others: Record<DocType, NumberingFormat>,
): string | null {
  if (!/^[A-Z]{0,4}$/.test(format.prefix)) return 'numbering_prefix_invalid';
  if (format.digits < 3 || format.digits > 8) return 'numbering_digits_invalid';
  // Two types sharing a prefix would print look-alike numbers for different documents.
  for (const type of DOC_TYPES) {
    if (CODELESS_TYPES.includes(type) || CODELESS_TYPES.includes(docType)) continue;
    if (type !== docType && others[type].prefix === format.prefix) return 'numbering_prefix_taken';
  }
  const worst = render(format, LONGEST_CODE, new Date(2099, 11, 31), 1);
  if (worst.length > MAX_NUMBER_LENGTH) return 'numbering_too_long';
  return null;
}

type Exec = Pick<typeof db, 'select' | 'execute'>;

export async function readFormats(exec: Pick<typeof db, 'select'> = db): Promise<Record<DocType, NumberingFormat>> {
  const rows = await exec.select().from(numberingFormatsTable);
  const out = { ...DEFAULT_FORMATS };
  for (const row of rows) {
    if (!(DOC_TYPES as readonly string[]).includes(row.doc_type)) continue;
    const date = (DATE_FORMATS as readonly string[]).includes(row.date_format)
      ? (row.date_format as DateFormat)
      : DEFAULT_FORMATS[row.doc_type as DocType].date_format;
    out[row.doc_type as DocType] = { prefix: row.prefix, date_format: date, digits: row.digits };
  }
  return out;
}

/**
 * The next number for this document — **inside the caller's transaction**, so a
 * failed write does not burn a number. The counter row is locked by the upsert.
 */
export async function issueNumber(
  exec: Exec,
  docType: DocType,
  branchCode: string,
  at: Date = new Date(),
): Promise<{ number: string; sequence: number }> {
  const formats = await readFormats(exec);
  const format = formats[docType];
  const stem = stemOf(format, branchCode, at);
  const result = await exec.execute(
    sql`INSERT INTO ${docCountersTable} (stem, last) VALUES (${stem}, 1)
        ON CONFLICT (stem) DO UPDATE SET last = ${docCountersTable}.last + 1
        RETURNING last`,
  );
  const list =
    (result as unknown as { rows?: { last: number }[] }).rows ?? (result as unknown as { last: number }[]);
  const sequence = Number(list[0]?.last ?? 1);
  return { number: shown(docType, stem + pad(sequence, format.digits), branchCode), sequence };
}

/** What the next number would be — for the settings preview; issues nothing. */
export async function peekNumber(
  format: NumberingFormat,
  branchCode: string,
  at: Date = new Date(),
  docType?: DocType,
): Promise<string> {
  const stem = stemOf(format, branchCode, at);
  const [row] = await db.select().from(docCountersTable).where(eq(docCountersTable.stem, stem)).limit(1);
  const next = stem + pad((row?.last ?? 0) + 1, format.digits);
  return docType === undefined ? next : shown(docType, next, branchCode);
}

export async function saveFormat(docType: DocType, format: NumberingFormat, userId: number): Promise<void> {
  await db
    .insert(numberingFormatsTable)
    .values({ doc_type: docType, ...format, updated_by: userId })
    .onConflictDoUpdate({
      target: numberingFormatsTable.doc_type,
      set: { ...format, updated_by: userId, updated_at: new Date() },
    });
}
