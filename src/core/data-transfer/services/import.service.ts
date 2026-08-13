import { randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { BusinessError, PayloadTooLargeError, ValidationError } from '../../http/api-error.js';
import { parseCsv, unguardFormula } from '../formats/csv.reader.js';
import { parseXlsx } from '../formats/xlsx.reader.js';
import { parseCell } from '../formats/cell.js';
import { importStagingTable } from '../schemas/import-staging.schema.js';
import {
  duplicateKey,
  isBlankKey,
  MAX_IMPORT_ROWS,
  MAX_PREVIEW_ROWS,
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

  /**
   * The importable column keys found in the file, in the resource's declared
   * order. These are the grid's headers; the client looks each one up in the
   * descriptor to show a localized label.
   */
  columns: string[];

  /**
   * **Every row of the file as raw text, valid and invalid alike** — the grid's
   * body.
   *
   * Echoing the user's own data back is what makes the errors actionable: a
   * list saying "row 12: invalid phone" asks them to go find row 12 in Excel,
   * whereas the same data on screen with that one cell tinted red is a
   * correction they make in place and re-check in seconds.
   *
   * Raw text, deliberately — not the coerced values. What the user typed is
   * what they must edit, and a `datetime` shown back as `2026-08-12T00:00:00Z`
   * when they typed `2026-08-12` looks like the app changed their file.
   */
  rows: Array<Record<string, string>>;

  /** `true` when the file exceeded [MAX_PREVIEW_ROWS] and `rows` is empty — the client shows the error list without a grid rather than a grid missing rows. */
  truncated_rows: boolean;
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
        severity: 'error',
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
        severity: 'error',
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
        severity: 'error',
      });
    }
  }

  return { raw, errors };
}

/**
 * Flags rows whose natural key repeats **within the file**.
 *
 * Needs no database, so it runs with everything else in [analyzeImport] and
 * catches the mistake people make most: pasting the same block twice, or
 * exporting, appending, and re-importing the whole thing.
 *
 * The error lands on the **second and later** occurrences and names the first,
 * because that is the one the user will delete. Flagging all of them, first
 * included, turns one mistake into two red rows and leaves them guessing which
 * to keep.
 *
 * Only rows that are otherwise valid are considered: a row already failing on a
 * required field does not also need "and it is a duplicate", which would be two
 * problems reported for one row that has to be fixed once.
 */
function flagInFileDuplicates(
  rows: RawRow[],
  uniqueBy: string[],
  invalidRows: Set<number>,
): ImportRowError[] {
  const errors: ImportRowError[] = [];
  const firstSeenAt = new Map<string, number>();

  rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    if (invalidRows.has(rowNumber)) return;

    const key = duplicateKey(raw, uniqueBy);
    // An all-empty key means the identifying columns are blank, which is
    // already reported as `required` if they are. Treating "" as a duplicate
    // would flag every such row against the first one.
    if (isBlankKey(key)) return;

    const first = firstSeenAt.get(key);
    if (first === undefined) {
      firstSeenAt.set(key, rowNumber);
      return;
    }

    errors.push({
      row: rowNumber,
      // Attached to the first key column so the grid has a cell to tint. With
      // a composite key the whole combination is the problem, but a user
      // looking for it starts at the name.
      column: uniqueBy[0] ?? null,
      code: 'duplicate_in_file',
      message: `Duplicate of row ${first}`,
      value: (raw[uniqueBy[0] ?? ''] ?? '').slice(0, 100),
      severity: 'error',
      duplicate_of_row: first,
    });
  });

  return errors;
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
export interface ImportAnalysis {
  /** Column keys present in the file, in the resource's declared order. */
  columnKeys: string[];
  /** **Every** row, valid and invalid, in file order. Index + 1 is the row number. */
  rows: RawRow[];
  errors: ImportRowError[];
  /** Row numbers with at least one `severity: 'error'` — the set excluded from the import. */
  invalidRows: Set<number>;
}

export function analyzeImport(
  resource: TransferResource,
  matrix: string[][],
): ImportAnalysis {
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

  const rows: RawRow[] = [];
  const errors: ImportRowError[] = [];
  const invalidRows = new Set<number>();

  dataRows.forEach((cells, index) => {
    // 1-based over **data** rows: the first row under the header is 1. The
    // client adds the header offset when it points at a spreadsheet line.
    const rowNumber = index + 1;
    const result = validateRow(resource, columns, cells, rowNumber);
    // Every row is kept, not only the good ones — the client renders the file
    // as a grid and needs the rows it is going to paint red.
    rows.push(result.raw);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      invalidRows.add(rowNumber);
    }
  });

  const uniqueBy = resource.import?.uniqueBy;
  if (uniqueBy && uniqueBy.length > 0) {
    const duplicates = flagInFileDuplicates(rows, uniqueBy, invalidRows);
    for (const error of duplicates) {
      errors.push(error);
      invalidRows.add(error.row);
    }
  }

  return {
    columnKeys: columns.filter((c): c is ColumnDef => c !== null).map((c) => c.key),
    rows,
    errors,
    invalidRows,
  };
}

/**
 * Marks rows whose natural key already exists in the database.
 *
 * Separate from [analyzeImport] because it is the one check that needs a query.
 * One query for the whole batch — see [TransferImportSpec.findExisting].
 *
 * A resource that declares `uniqueBy` but no `findExisting` gets in-file
 * duplicate detection only, and that is a legitimate configuration: catching
 * the paste-twice mistake is most of the value, and a unique index will still
 * refuse the rest at commit time.
 */
async function flagDatabaseDuplicates(
  resource: TransferResource,
  ctx: TransferContext,
  analysis: ImportAnalysis,
): Promise<ImportRowError[]> {
  const spec = resource.import;
  const uniqueBy = spec?.uniqueBy;
  if (!spec?.findExisting || !uniqueBy || uniqueBy.length === 0) return [];

  const candidates = analysis.rows
    .map((raw, index) => ({ raw, rowNumber: index + 1 }))
    .filter(({ rowNumber }) => !analysis.invalidRows.has(rowNumber))
    .map(({ raw, rowNumber }) => ({ rowNumber, raw, key: duplicateKey(raw, uniqueBy) }))
    .filter(({ key }) => !isBlankKey(key));

  if (candidates.length === 0) return [];

  const existing = await spec.findExisting(ctx, [...new Set(candidates.map((c) => c.key))]);
  if (existing.size === 0) return [];

  const policy = spec.onDuplicate ?? 'error';
  // `update` means the resource's `commit` upserts, so an existing record is
  // not a problem at all and nothing is reported.
  if (policy === 'update') return [];

  return candidates
    .filter(({ key }) => existing.has(key))
    .map(({ rowNumber, raw }) => ({
      row: rowNumber,
      column: uniqueBy[0] ?? null,
      code: 'duplicate_in_database',
      message:
        policy === 'skip'
          ? 'Already exists — this row will be skipped'
          : 'A record with this value already exists',
      value: (raw[uniqueBy[0] ?? ''] ?? '').slice(0, 100),
      // `skip` is the configured policy working as intended, not the user's
      // mistake. Painting it the same red as a broken phone number would make
      // a correct import look like it failed.
      severity: policy === 'skip' ? ('warning' as const) : ('error' as const),
    }));
}

/**
 * Phase one, from an uploaded file.
 *
 * `mode=validate` with a multipart body. The file is parsed into a text matrix
 * and handed to [validateMatrix], which is also what the edit loop uses — so a
 * row cannot be judged one way on upload and another way after the user touched
 * a cell.
 */
export async function validateImport(
  resource: TransferResource,
  ctx: TransferContext,
  file: { buffer: Buffer; originalname: string },
  format: TransferFormat,
): Promise<ImportValidateReport> {
  requireImportable(resource);
  if (!resource.importFormats.includes(format)) {
    throw new ValidationError({ format: [`"${format}" is not importable for "${resource.name}"`] });
  }

  const matrix = await toMatrix(file.buffer, format);
  return validateMatrix(resource, ctx, matrix);
}

/**
 * Phase one again, from **rows the user edited in the app**.
 *
 * `mode=validate` with a JSON body. This is what closes the loop: upload → see
 * the red cells → fix them in the grid → re-check → import. Without it the only
 * way to correct a file is to leave the app, edit in Excel, and upload again —
 * which for three bad cells in five hundred rows is the reason people give up
 * on imports.
 *
 * It goes through the **same** [validateMatrix] as the upload path, on purpose.
 * A separate "re-validate" path would be a second copy of the rules, and the
 * two would drift until the app accepted rows the upload refused.
 */
export function validateEditedRows(
  resource: TransferResource,
  ctx: TransferContext,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): Promise<ImportValidateReport> {
  requireImportable(resource);

  if (columns.length === 0) {
    throw new ValidationError({ columns: ['At least one column is required'] });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new PayloadTooLargeError(
      `This import has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}`,
      { row_count: rows.length, max_rows: MAX_IMPORT_ROWS },
      'import_too_large',
    );
  }

  // Rebuilt into the same header-plus-cells matrix a file produces, so there is
  // exactly one code path from here on. Everything is stringified because the
  // grid edits text — and because a client that sent `{"count": 5}` and one
  // that sent `{"count": "5"}` must not get different answers.
  const matrix: string[][] = [
    columns,
    ...rows.map((row) =>
      columns.map((key) => {
        const value = row[key];
        return value === null || value === undefined ? '' : String(value);
      }),
    ),
  ];

  return validateMatrix(resource, ctx, matrix);
}

/** The single implementation both entry points share. */
async function validateMatrix(
  resource: TransferResource,
  ctx: TransferContext,
  matrix: string[][],
): Promise<ImportValidateReport> {
  const analysis = analyzeImport(resource, matrix);

  // The database check runs after the cheap ones, and only over rows that
  // survived them — no point asking whether a row with no name already exists.
  const dbDuplicates = await flagDatabaseDuplicates(resource, ctx, analysis);
  for (const error of dbDuplicates) {
    analysis.errors.push(error);
    if (error.severity === 'error') analysis.invalidRows.add(error.row);
  }

  // `warning` rows (duplicates under `skip`) are excluded from the write but
  // are not the user's problem to fix — so they are counted separately rather
  // than folded into either bucket.
  const skippedRows = new Set(
    dbDuplicates.filter((e) => e.severity === 'warning').map((e) => e.row),
  );

  const accepted = analysis.rows.filter((_, index) => {
    const rowNumber = index + 1;
    return !analysis.invalidRows.has(rowNumber) && !skippedRows.has(rowNumber);
  });

  const truncatedErrors = analysis.errors.length > MAX_REPORTED_ROW_ERRORS;
  const truncatedRows = analysis.rows.length > MAX_PREVIEW_ROWS;

  // A token is issued only when something can actually be written. Handing one
  // back for zero valid rows invites a commit that reports "inserted: 0" as a
  // success.
  const token = accepted.length > 0 ? await stageRows(resource, ctx, accepted) : null;

  return {
    token,
    expires_in: TOKEN_TTL_SECONDS,
    total_rows: analysis.rows.length,
    valid_rows: accepted.length,
    errors: truncatedErrors
      ? analysis.errors.slice(0, MAX_REPORTED_ROW_ERRORS)
      : analysis.errors,
    truncated_errors: truncatedErrors,
    columns: analysis.columnKeys,
    // Empty rather than partial past the cap: a grid silently missing rows 2001
    // and up would have the user editing a file they cannot see all of.
    rows: truncatedRows ? [] : analysis.rows,
    truncated_rows: truncatedRows,
  };
}

function requireImportable(resource: TransferResource): void {
  if (!resource.import) {
    throw new BusinessError(
      400,
      `"${resource.name}" does not support import`,
      'transfer_import_unsupported',
    );
  }
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
    throw new BusinessError(
      400,
      `"${resource.name}" does not support import`,
      'transfer_import_unsupported',
    );
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
  // `BusinessError`, not `NotFoundError`, for the one reason that matters to the
  // person reading it: only the former carries a `messageKey`, and this sentence
  // is read by an end user rather than redrawn by the client. Without one it
  // arrived as English text inside an Arabic screen (reported 2026-08-13). The
  // status stays 404 — the token genuinely is not there.
  if (!record) throw importGoneError();

  if (record.expires_at.getTime() < Date.now()) {
    await db.delete(importStagingTable).where(eq(importStagingTable.token, token));
    throw importGoneError();
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

  try {
    const counts = await resource.import.commit(ctx, typedRows);
    return { ...counts, failed };
  } catch (err: unknown) {
    // A collision here is **expected**, not exceptional, and it has to read that
    // way. `findExisting` runs during validate, so between the review and this
    // write there is a window: another admin can create the same branch, and a
    // resource that declares no `findExisting` at all relies on the unique index
    // as its only duplicate check. Either way the row that arrives is one the
    // database refuses.
    //
    // Left to propagate, that is a 500 — "something went wrong" for a situation
    // the user can act on in one step. The transaction inside `commit` has
    // already rolled the whole batch back, so what is true is simple: nothing
    // was written, and the file needs re-uploading to see which rows collide
    // (validate names them per cell).
    if (isUniqueViolation(err)) {
      throw new BusinessError(
        409,
        'Some rows collide with records that already exist. Nothing was imported — upload the file again to see which rows.',
        'import_conflict',
      );
    }
    throw err;
  }
}

/** 404 with a key — see the call site for why this is not `NotFoundError`. */
function importGoneError(): BusinessError {
  return new BusinessError(
    404,
    'This import has expired or was already used',
    'import_token_gone',
  );
}

/**
 * A `23505` from anywhere under the resource's `commit`.
 *
 * The code is checked on the error **and on its cause**: the pg driver's own
 * `DatabaseError` carries it directly, while a driver or ORM that wraps its
 * errors puts the original one layer down. Matching on the message text instead
 * would break the first time a deployment ran Postgres in another locale.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (candidate: unknown): unknown =>
    typeof candidate === 'object' && candidate !== null
      ? (candidate as { code?: unknown }).code
      : undefined;

  if (code(err) === '23505') return true;
  const cause = typeof err === 'object' && err !== null ? (err as { cause?: unknown }).cause : undefined;
  return code(cause) === '23505';
}
