import { randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  BusinessError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../../http/api-error.js';
import { parseCsv, unguardFormula } from '../formats/csv.reader.js';
import { parseXlsx } from '../formats/xlsx.reader.js';
import { parseCell } from '../formats/cell.js';
import { importStagingTable } from '../schemas/import-staging.schema.js';
import {
  MAX_IMPORT_ROWS,
  MAX_REPORTED_ROW_ERRORS,
  type ColumnDef,
  type ImportRowError,
  type TransferContext,
  type TransferFormat,
  type TransferResource,
} from '../types.js';

/**
 * Two-phase import: **validate, then commit**.
 *
 * Phase one parses the file, checks every row against the resource's schema and
 * answers a report the user reads — with a token. Phase two spends the token
 * and writes, inside one transaction.
 *
 * The split exists because the single-shot alternative forces a choice between
 * two bad answers on a file with three bad rows out of five hundred: write the
 * 497 and leave the user to work out which failed, or refuse all 500 and make
 * them guess what was wrong. Here they see the three, fix or accept them, and
 * commit knowingly.
 *
 * Both phases re-derive everything from the resource declaration. Nothing about
 * *what is valid* is stored between them — see `import-staging.schema.ts`.
 */

const TOKEN_TTL_SECONDS = 15 * 60;

/** Raw text row, keyed by column. What is staged and what commit re-validates. */
type RawRow = Record<string, string>;

export interface ImportValidateReport {
  /** `null` when there is nothing worth committing — the client shows the errors and offers no confirm button. */
  token: string | null;
  expires_in: number;
  total_rows: number;
  valid_rows: number;
  errors: ImportRowError[];
  /** `true` when [MAX_REPORTED_ROW_ERRORS] trimmed the list — "the first 200 of many", not "200 problems". */
  truncated_errors: boolean;
}

export interface ImportCommitReport {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
}

// ─── Phase one: validate ─────────────────────────────────────────────────────

async function toMatrix(buffer: Buffer, format: TransferFormat): Promise<string[][]> {
  if (format === 'xlsx') return parseXlsx(buffer);
  // `utf8` decoding handles the BOM our own exports start with; `parseCsv`
  // strips it. A file saved as UTF-16 by a user arrives as mojibake and fails
  // header matching, which is the right outcome — it is not a file we wrote.
  return parseCsv(buffer.toString('utf8'));
}

/**
 * Maps the file's header row onto column keys.
 *
 * **Unknown headers are refused; known-but-not-importable headers are ignored.**
 * That asymmetry is the whole reason the ordinary workflow — export everything,
 * edit two cells in Excel, import the same file back — works at all. An
 * exported file carries `id`, `created_at` and `updated_at`; treating those as
 * errors would make the app's own output un-importable by the app. A header
 * that matches nothing, on the other hand, almost always means the wrong file
 * or the wrong resource, and continuing would silently drop a column the user
 * believes they are importing.
 */
function mapHeader(
  resource: TransferResource,
  header: string[],
): { columns: Array<ColumnDef | null> } {
  const byKey = new Map(resource.columns.map((c) => [c.key, c]));

  const unknown: string[] = [];
  const columns = header.map((raw) => {
    const key = raw.trim();
    if (key === '') return null;
    const column = byKey.get(key);
    if (!column) {
      unknown.push(key);
      return null;
    }
    return column.importable ? column : null;
  });

  if (unknown.length > 0) {
    throw new ValidationError({
      file: [`Unrecognised column(s): ${unknown.join(', ')}`],
    });
  }

  const missingRequired = resource.columns
    .filter((c) => c.importable && c.required)
    .filter((c) => !columns.some((mapped) => mapped?.key === c.key))
    .map((c) => c.key);

  if (missingRequired.length > 0) {
    // A file-level refusal, not a per-row error: every row would carry the
    // identical complaint, and 500 copies of it is not a report anyone reads.
    throw new ValidationError({
      file: [`Missing required column(s): ${missingRequired.join(', ')}`],
    });
  }

  if (!columns.some((c) => c !== null)) {
    throw new ValidationError({ file: ['No importable column found in this file'] });
  }

  return { columns };
}

/**
 * Coerces one file row to typed values and runs the resource's schema over it.
 *
 * Cell-level type failures are reported **without** consulting the schema —
 * they name the column and the offending text, which a zod message flattened
 * from a whole-object parse cannot do.
 */
function validateRow(
  resource: TransferResource,
  mapped: Array<ColumnDef | null>,
  cells: string[],
  rowNumber: number,
): { raw: RawRow; errors: ImportRowError[] } {
  const errors: ImportRowError[] = [];
  const raw: RawRow = {};
  const typed: Record<string, unknown> = {};

  mapped.forEach((column, index) => {
    if (!column) return;
    const text =
      column.type === 'string' ? unguardFormula(cells[index] ?? '') : (cells[index] ?? '');
    raw[column.key] = text;

    const parsed = parseCell(text, column.type);
    if (!parsed.ok) {
      errors.push({
        row: rowNumber,
        column: column.key,
        code: parsed.code,
        message: `Invalid value for "${column.key}"`,
        value: text.slice(0, 100),
      });
      return;
    }
    if (parsed.value === null && column.required) {
      errors.push({
        row: rowNumber,
        column: column.key,
        code: 'required',
        message: `"${column.key}" is required`,
        value: '',
      });
      return;
    }
    if (parsed.value !== null) typed[column.key] = parsed.value;
  });

  if (errors.length > 0) return { raw, errors };

  const result = resource.import!.rowSchema.safeParse(typed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        row: rowNumber,
        // A cross-field rule (zod `.refine` at object level) has an empty path
        // and belongs to the row, not to any one cell.
        column: issue.path.length > 0 ? String(issue.path[0]) : null,
        code: issue.code,
        message: issue.message,
        ...(issue.path.length > 0 ? { value: (raw[String(issue.path[0])] ?? '').slice(0, 100) } : {}),
      });
    }
  }

  return { raw, errors };
}

/**
 * Everything phase one does **except touch the database** — header mapping,
 * per-row validation, error collection, the row cap.
 *
 * Separate from [validateImport] so the rules can be tested exhaustively
 * without a Postgres: this is where every accept/refuse decision lives, and
 * decisions that need infrastructure to test get tested less. Staging is the
 * only part left needing a database, and it stores what this returns.
 */
export function analyzeImport(
  resource: TransferResource,
  matrix: string[][],
): { accepted: RawRow[]; errors: ImportRowError[]; totalRows: number } {
  if (matrix.length === 0) {
    throw new ValidationError({ file: ['The file is empty'] });
  }

  const { columns } = mapHeader(resource, matrix[0]!);
  const dataRows = matrix.slice(1);

  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new PayloadTooLargeError(
      `This file has ${dataRows.length} rows; the limit is ${MAX_IMPORT_ROWS}`,
      { row_count: dataRows.length, max_rows: MAX_IMPORT_ROWS },
      'import_too_large',
    );
  }

  const accepted: RawRow[] = [];
  const errors: ImportRowError[] = [];

  dataRows.forEach((cells, index) => {
    // 1-based over **data** rows: the first row under the header is 1. The
    // client adds the header offset when it points at a spreadsheet line.
    const result = validateRow(resource, columns, cells, index + 1);
    if (result.errors.length === 0) accepted.push(result.raw);
    else errors.push(...result.errors);
  });

  return { accepted, errors, totalRows: dataRows.length };
}

export async function validateImport(
  resource: TransferResource,
  ctx: TransferContext,
  file: { buffer: Buffer; originalname: string },
  format: TransferFormat,
): Promise<ImportValidateReport> {
  if (!resource.import) {
    throw new BusinessError(400, `"${resource.name}" does not support import`);
  }
  if (!resource.importFormats.includes(format)) {
    throw new ValidationError({ format: [`"${format}" is not importable for "${resource.name}"`] });
  }

  const matrix = await toMatrix(file.buffer, format);
  const { accepted, errors, totalRows } = analyzeImport(resource, matrix);

  const truncated = errors.length > MAX_REPORTED_ROW_ERRORS;

  // A token is issued only when something can actually be written. Handing one
  // back for zero valid rows invites a commit that reports "inserted: 0" as a
  // success.
  const token = accepted.length > 0 ? await stageRows(resource, ctx, accepted) : null;

  return {
    token,
    expires_in: TOKEN_TTL_SECONDS,
    total_rows: totalRows,
    valid_rows: accepted.length,
    errors: truncated ? errors.slice(0, MAX_REPORTED_ROW_ERRORS) : errors,
    truncated_errors: truncated,
  };
}

// ─── Staging ─────────────────────────────────────────────────────────────────

async function stageRows(
  resource: TransferResource,
  ctx: TransferContext,
  rows: RawRow[],
): Promise<string> {
  const token = `imp_${randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

  // Sweep first. Expired staging rows are a copy of somebody's data with no
  // remaining purpose, and no scheduled job exists in this template to remove
  // them — so the write path does it, which costs one indexed delete and means
  // the table cannot grow without bound on a deployment that never adds a cron.
  await db.delete(importStagingTable).where(lt(importStagingTable.expires_at, new Date()));

  await db.insert(importStagingTable).values({
    token,
    user_id: ctx.userId,
    resource: resource.name,
    rows,
    row_count: rows.length,
    expires_at: expiresAt,
  });

  return token;
}

// ─── Phase two: commit ───────────────────────────────────────────────────────

export async function commitImport(
  resource: TransferResource,
  ctx: TransferContext,
  token: string,
): Promise<ImportCommitReport> {
  if (!resource.import) {
    throw new BusinessError(400, `"${resource.name}" does not support import`);
  }

  const staged = await db
    .select()
    .from(importStagingTable)
    .where(
      and(
        eq(importStagingTable.token, token),
        // Owner and resource are part of the lookup, not checked after it. A
        // token belonging to another account, or issued for another resource,
        // is indistinguishable from one that never existed — the same reason
        // notes are scoped in the WHERE clause.
        eq(importStagingTable.user_id, ctx.userId),
        eq(importStagingTable.resource, resource.name),
      ),
    )
    .limit(1);

  const record = staged[0];
  if (!record) throw new NotFoundError('This import has expired or was already used');

  if (record.expires_at.getTime() < Date.now()) {
    await db.delete(importStagingTable).where(eq(importStagingTable.token, token));
    throw new NotFoundError('This import has expired or was already used');
  }

  const rawRows = record.rows as RawRow[];

  // Re-validated, not trusted. The staged payload is raw text by design, and
  // re-running the same schema is what turns it back into typed values — while
  // also meaning a row cannot reach `commit()` on the strength of a staging
  // record alone.
  const typedRows: unknown[] = [];
  let failed = 0;

  rawRows.forEach((raw, index) => {
    const cells = resource.columns.map((c) => raw[c.key] ?? '');
    const mapped = resource.columns.map((c) => (c.key in raw && c.importable ? c : null));
    const result = validateRow(resource, mapped, cells, index + 1);
    if (result.errors.length > 0) {
      failed += 1;
      return;
    }
    const typed: Record<string, unknown> = {};
    mapped.forEach((column) => {
      if (!column) return;
      const parsed = parseCell(raw[column.key] ?? '', column.type);
      if (parsed.ok && parsed.value !== null) typed[column.key] = parsed.value;
    });
    typedRows.push(resource.import!.rowSchema.parse(typed));
  });

  // Consumed before the write, so a token is spendable exactly once. A retry
  // after a failed commit re-uploads rather than replaying a payload whose
  // effect on the database is now unknown.
  await db.delete(importStagingTable).where(eq(importStagingTable.token, token));

  const counts = await resource.import.commit(ctx, typedRows);

  return { ...counts, failed };
}
