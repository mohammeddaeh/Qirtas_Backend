import type { ZodTypeAny } from 'zod';

/**
 * The vocabulary every import/export resource is described in.
 *
 * Nothing here knows about notes, users, or any other table. A feature
 * *declares* a [TransferResource] and the generic engine
 * (`services/export.service.ts`, `services/import.service.ts`) does the rest —
 * which is what lets the Flutter client render an export screen for a resource
 * it has never heard of, from `GET /api/v1/data-transfer/resources` alone.
 *
 * See `docs/rest_api.md` §Data transfer for the wire shapes these produce.
 */

export type TransferFormat = 'csv' | 'xlsx';

/** Both languages, always. A label with only one is a label the other half of the users cannot read. */
export interface LocalizedLabel {
  ar: string;
  en: string;
}

/**
 * How a cell is serialised on export and parsed back on import.
 *
 * Deliberately a small closed set rather than "anything zod can express": the
 * *client* renders a column picker and an error table from these, and a type it
 * does not recognise has no rendering. Richer per-column rules belong in the
 * resource's `rowSchema`, which runs server-side where it can be arbitrary.
 */
export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'datetime';

export interface ColumnDef {
  /** Wire key — the header written to the file and the `column` reported in an import error. Never the label. */
  key: string;
  label: LocalizedLabel;
  type: ColumnType;
  /** Import-side: an empty cell in this column is a row error. Ignored on export. */
  required?: boolean;
  /**
   * `false` excludes the column from import templates and rejects it if
   * present in an uploaded file. Server-assigned columns (`id`, `created_at`)
   * are exportable and never importable — defaults to `true`.
   */
  importable?: boolean;

  /**
   * A **sample value**, written into the generated template's example row.
   *
   * Its job is to teach the *format*: `0912345678` tells a user what a phone
   * number has to look like in a way no sentence does. It is data, and it goes
   * in the file.
   */
  example?: string;

  /**
   * A **short explanation of what the column means**, shown in the app beside
   * the column name. Never written into a file.
   *
   * Distinct from [example] on purpose, because the two answer different
   * questions and the UI was answering the wrong one: showing `فرع الكورنيش`
   * under "Branch name" tells the reader what a branch is called, not what to
   * put there or why it matters. `example` is a value; `hint` is a meaning.
   *
   * Keep it to one line. It sits under a label in a list, not in a manual.
   */
  hint?: LocalizedLabel;
}

/**
 * A filter the export screen should render — declared by the resource, like
 * everything else the client draws.
 *
 * **This exists because the client was hardcoding one.** The export screen
 * shipped with a single text field wired to `?q=`, which happened to match the
 * reference resource. The first real application declared its filter as
 * `search`, so the field sent a parameter the schema ignored and quietly
 * filtered nothing — a control that looks like it works, does nothing, and
 * reports no error. Exactly the coupling the rest of this module exists to
 * avoid, left in one screen.
 *
 * The keys here must match [TransferResourceDefinition.filtersSchema]'s keys;
 * `defineTransferResource` cannot check that (a zod schema does not reliably
 * enumerate), so it is on the resource to keep them together — which is why
 * they sit two lines apart in the declaration.
 */
export interface TransferFilterDef {
  /** Query-string key. Sent verbatim: `?search=…`. */
  key: string;
  label: LocalizedLabel;
  /**
   * How the client renders it. `text` is a free-text box; the closed sets are
   * a dropdown built from [options].
   */
  type: 'text' | 'select' | 'boolean';
  /** Placeholder text for `text`, so the box says what it searches. */
  placeholder?: LocalizedLabel;
  /** Required for `select`. */
  options?: Array<{ value: string; label: LocalizedLabel }>;
}

/** A single serialisable cell value produced by [TransferResource.readRows]. */
export type TransferCell = string | number | boolean | Date | null | undefined;

/** One record as the resource hands it over — keyed by [ColumnDef.key]. */
export type TransferRow = Record<string, TransferCell>;

/**
 * Everything a resource is allowed to know about who is asking.
 *
 * Only `userId` for now, and that is the point: every read and every write goes
 * through the same ownership scoping the feature's own repository already
 * enforces, so an export can never widen what an endpoint would return. A
 * resource that needs roles gets them from its own service, not from here.
 */
export interface TransferContext {
  userId: number;
}

/** Whatever the resource's `filtersSchema` parsed out of the query string. */
export type TransferFilters = Record<string, unknown>;

/** What a caller is trying to do, passed to [TransferResourceDefinition.authorize]. */
export type TransferAction = 'export' | 'import';

/**
 * What to do with a row whose natural key already exists in the database.
 *
 * `error` — the row is refused and the user is told which existing record it
 * collides with. The safe default: an import that silently changes existing
 * data is the single most expensive kind of mistake this feature can make.
 *
 * `skip` — the row is left out and counted in `skipped`. Correct for
 * "top up the list with whatever is new", where re-uploading last month's file
 * should be a no-op rather than an error report.
 *
 * `update` — the row is passed through to `commit`, which must upsert. Only
 * choose this when the file is authoritative over the database.
 */
export type DuplicatePolicy = 'error' | 'skip' | 'update';

/**
 * Import half of a resource declaration. Absent = export-only.
 */
export interface TransferImportSpec {
  /**
   * Validates and coerces ONE row, already keyed by column and with cells
   * coerced from text by [ColumnType]. Reuse the feature's existing create
   * schema wherever possible — a second, drifting copy of the same rules is
   * exactly how an import starts accepting rows the API would refuse.
   */
  rowSchema: ZodTypeAny;

  /**
   * Column keys that together identify a record — a branch's `name`, a
   * product's `sku`, an employee's `national_id`.
   *
   * Declaring it turns on duplicate detection, which is the failure users hit
   * most and understand least. Two things become possible:
   *
   * 1. **Two rows in one file with the same key** — caught with no database
   *    access at all, and reported against the *second* occurrence naming the
   *    first ("duplicate of row 12"), so the user can see both.
   * 2. **A row whose key already exists** — caught by [findExisting], and
   *    handled per [onDuplicate].
   *
   * Omit it for a resource with no natural key (`notes` has none: two notes may
   * legitimately share a title). Omitting means duplicates are simply not
   * detected, which is correct there and wrong almost everywhere else.
   */
  uniqueBy?: string[];

  /** Default `error`. Ignored when [uniqueBy] is absent. */
  onDuplicate?: DuplicatePolicy;

  /**
   * Given the natural keys of every otherwise-valid row, returns the subset
   * that already exists.
   *
   * One query for the whole batch, not one per row: a 5 000-row import would
   * otherwise issue 5 000 round trips inside the validation request.
   *
   * Keys arrive already normalised by [duplicateKey] — lower-cased and
   * trimmed — so the implementation must compare the same way, or "الفرع
   * الرئيسي" and "الفرع الرئيسي " will be treated as different records here
   * and identical by the database's unique index.
   */
  findExisting?(ctx: TransferContext, keys: string[]): Promise<Set<string>>;

  /**
   * Writes the validated rows. **Must run inside a single transaction** — the
   * import contract promises the caller that a failed commit left nothing
   * behind, and this function is the only place that can keep it.
   *
   * Receives every row at once rather than one at a time so the implementation
   * can batch its inserts; `import.service.ts` has already capped the count.
   */
  commit(ctx: TransferContext, rows: unknown[]): Promise<TransferCommitCounts>;
}

export interface TransferCommitCounts {
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * A resource as a feature declares it. Build with `defineTransferResource()`
 * from `registry.ts` — that applies the defaults this interface leaves
 * optional, so nothing downstream has to re-check them.
 */
export interface TransferResourceDefinition {
  name: string;
  label: LocalizedLabel;
  columns: ColumnDef[];

  exportFormats?: TransferFormat[];
  importFormats?: TransferFormat[];

  /**
   * Refuse rather than stream, above this many rows. Default
   * [DEFAULT_MAX_EXPORT_ROWS].
   *
   * The cap is answered as a 413 **before** a single row is read, using
   * [countRows]. A synchronous export has no other honest failure mode: the
   * alternative is a request that holds a connection for minutes and then dies
   * to a proxy timeout, which reaches the user as "nothing happened".
   */
  maxExportRows?: number;

  /**
   * Parses the export query string into [TransferFilters]. Omit for a resource
   * with no filters.
   *
   * **Keep its keys in step with [filters] below** — this one enforces, that
   * one is what the client draws, and a mismatch is a control that filters
   * nothing without erroring.
   */
  filtersSchema?: ZodTypeAny;

  /**
   * What the export screen renders. Absent = no filter controls at all.
   *
   * Declared rather than inferred from [filtersSchema]: a zod schema does not
   * carry labels, placeholders or the two languages every label needs.
   */
  filters?: TransferFilterDef[];

  /**
   * Refuses the caller by **throwing** (`ForbiddenError`). Runs first, before
   * any column, filter or file is looked at.
   *
   * **Omitting this is only safe when the resource's own queries already scope
   * every row to the caller**, the way `notes` does in its WHERE clause. For
   * anything else it is required, and here is why:
   *
   * The generic routes carry `requireAuth` and nothing more — they cannot know
   * what any given resource considers privileged. In an application with
   * role-based access, `POST /branches` may require `branches.manage` while
   * this module's import route would happily accept a spreadsheet from any
   * signed-in user. That is not a smaller version of the same permission; it
   * is a **complete bypass of it**, reached through a different URL. The same
   * applies in reverse to export, which is a bulk read of every row the
   * resource can produce.
   *
   * The check lives on the resource rather than on the route because only the
   * resource knows what its data is worth — and because `core/` must not learn
   * about any particular application's permission model.
   *
   * ```ts
   * authorize: async (ctx, action) => {
   *   if (action === 'import') await requirePermissionFor(ctx.userId, 'branches.manage');
   * },
   * ```
   */
  authorize?(ctx: TransferContext, action: TransferAction): Promise<void> | void;

  /** How many rows the export would produce. Runs before any row is read. */
  countRows(ctx: TransferContext, filters: TransferFilters): Promise<number>;

  /**
   * Yields rows in a stable order, lazily.
   *
   * An `AsyncIterable`, not an array: the whole point of the row cap being
   * 50 000 rather than 500 is that the engine never holds more than one page in
   * memory. Implement it by paging the feature's own repository — see
   * `features/notes/notes.transfer.ts`.
   */
  readRows(ctx: TransferContext, filters: TransferFilters): AsyncIterable<TransferRow>;

  import?: TransferImportSpec;
}

/** Same shape with the optionals resolved. What the registry stores and every service consumes. */
export interface TransferResource extends TransferResourceDefinition {
  exportFormats: TransferFormat[];
  importFormats: TransferFormat[];
  maxExportRows: number;
  columns: Array<ColumnDef & { importable: boolean; required: boolean }>;
}

/**
 * 50 000 rows ≈ a few MB of CSV and a few seconds of streaming — comfortably
 * inside any default proxy timeout, and far more than a human opens in Excel.
 * A resource with genuinely larger exports should say so explicitly rather than
 * inherit a number chosen for the common case.
 */
export const DEFAULT_MAX_EXPORT_ROWS = 50_000;

/**
 * Hard ceiling on rows accepted from an uploaded file, independent of the
 * resource. Beyond this the file is refused before parsing finishes — an
 * unbounded import is a memory exhaustion primitive handed to any signed-in
 * user.
 */
export const MAX_IMPORT_ROWS = 10_000;

/**
 * At most this many row errors are reported back. A file where every row is
 * wrong (a mis-picked file, the wrong resource) would otherwise produce a
 * response larger than the upload — and no one reads error 4 000.
 *
 * When the cap trims the list the report says so via `truncated_errors`, so the
 * client can tell "13 problems" from "the first 200 of many".
 */
export const MAX_REPORTED_ROW_ERRORS = 200;

/**
 * How many rows are echoed back for the client to render as an editable grid.
 *
 * The whole file is validated regardless — this caps only what travels back.
 * 2 000 rows of short text is a few hundred KB, which a phone renders and holds
 * comfortably; the full 10 000 would be both a slow response and a grid nobody
 * scrolls. Past the cap the client shows the errors without the grid, because a
 * partial grid that silently omits rows is worse than none.
 */
export const MAX_PREVIEW_ROWS = 2_000;

/**
 * Builds the comparison key for [TransferImportSpec.uniqueBy].
 *
 * Lower-cased, trimmed, whitespace-collapsed, and joined with a character no
 * keyboard produces — so `("A", "b")` and `("A|b", "")` cannot collide into the
 * same key and produce a duplicate report the user cannot explain.
 *
 * The normalisation is not cosmetic: `"الفرع الرئيسي "` and `"الفرع الرئيسي"`
 * are the same branch to a person and to most unique indexes, and treating them
 * as different here would let a file import twice.
 */
/**
 * Joins the parts of a composite key. Unit Separator (U+001F) — no keyboard
 * produces it, so `("a", "b")` and `("a|b", "")` cannot collide into one key and
 * report a duplicate the user cannot explain.
 *
 * Written as an escape rather than typed. A literal control character is
 * invisible in an editor, and [isBlankKey] has to match this exact byte — they
 * were briefly two different characters (U+001F here, U+0000 there), and the
 * symptom was every all-blank row being flagged a duplicate of the first.
 */
const KEY_SEPARATOR = '\u001f';

export function duplicateKey(row: Record<string, string>, uniqueBy: string[]): string {
  return uniqueBy
    .map((key) => (row[key] ?? '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join(KEY_SEPARATOR);
}

/**
 * True when every column making up the key is empty.
 *
 * Such a row is not a duplicate of anything — its identifying columns are
 * simply not filled in, which `required` already reports when it matters.
 */
export function isBlankKey(key: string): boolean {
  return key.split(KEY_SEPARATOR).every((part) => part === '');
}

/**
 * One problem, addressed **the way the user sees their file**: a row number and
 * a column — that is, a cell.
 *
 * The client renders the uploaded file as a grid and paints exactly these
 * coordinates red, so a user with 40 problems in 500 rows is looking at the
 * cells rather than reading a list and counting lines. Everything about this
 * shape exists to make that intersection unambiguous.
 */
export interface ImportRowError {
  /**
   * 1-based **data** row — the first row under the header is 1, not 2.
   *
   * The client adds the header offset itself when it labels a spreadsheet line.
   * Getting this wrong points every user at the wrong row and fails silently,
   * which is why it is stated here and asserted on both sides.
   */
  row: number;

  /** [ColumnDef.key], or `null` for a whole-row problem (a failed cross-field rule). */
  column: string | null;

  /** Machine-readable discriminator — see [ImportErrorCode]. Branch on this, never on [message]. */
  code: string;

  /** Human text, already resolved to the request language. */
  message: string;

  /** The offending cell as it appeared in the file, truncated. Absent for whole-row problems. */
  value?: string;

  /**
   * `error` — the row cannot be imported until the user changes something.
   * `warning` — the row is being left out by policy, not by mistake (a
   * duplicate under `onDuplicate: 'skip'`). The grid tints these differently:
   * an amber cell the user may ignore is not the same as a red one they must
   * fix, and colouring both red makes a clean import look broken.
   */
  severity: 'error' | 'warning';

  /** For duplicate errors: the other row it collides with (in-file), 1-based. */
  duplicate_of_row?: number;
}

/**
 * The codes this engine emits. A resource's own `rowSchema` adds zod's codes
 * (`too_big`, `invalid_string`, `custom`, …) on top.
 *
 * Kept as a named union so the Flutter side can map each to a localized
 * explanation and a suggested fix, rather than showing whatever English the
 * server happened to produce.
 */
export type ImportErrorCode =
  | 'required'
  | 'invalid_number'
  | 'invalid_boolean'
  | 'invalid_date'
  | 'invalid_date_format'
  | 'duplicate_in_file'
  | 'duplicate_in_database';
