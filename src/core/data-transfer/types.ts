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
  /** Shown in the generated template's example row. Optional; purely cosmetic. */
  example?: string;
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

  /** Parses the export query string into [TransferFilters]. Omit for a resource with no filters. */
  filtersSchema?: ZodTypeAny;

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

/** One cell-level problem, addressed the way the user sees the file: by row number and column. */
export interface ImportRowError {
  /** 1-based **data** row — the first row under the header is 1, not 2. The client adds the header offset when it points at a spreadsheet. */
  row: number;
  /** [ColumnDef.key], or `null` for a whole-row problem (unknown columns, a failed cross-field rule). */
  column: string | null;
  /** Machine-readable discriminator: `required`, `invalid_type`, `unknown_column`, `too_long`, … */
  code: string;
  /** Human text, already resolved to the request language. */
  message: string;
  /** The offending cell as it appeared in the file, truncated. Absent for whole-row problems. */
  value?: string;
}
