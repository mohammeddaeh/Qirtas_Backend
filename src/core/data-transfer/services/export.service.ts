import type { Writable } from 'node:stream';
import { z } from 'zod';
import { PayloadTooLargeError, ValidationError } from '../../http/api-error.js';
import { csvChunks } from '../formats/csv.writer.js';
import { writeXlsx } from '../formats/xlsx.writer.js';
import type {
  ColumnDef,
  TransferContext,
  TransferFilters,
  TransferFormat,
  TransferResource,
} from '../types.js';

/**
 * Turns a request into an [ExportPlan] — or refuses it before a single row is
 * read.
 *
 * The order of the four steps below is the whole design. Column selection and
 * filter parsing are cheap and fail loudly, so they happen first; the row count
 * is one aggregate query and gates everything after it. By the time
 * [ExportPlan.write] runs, the only remaining failure modes are the network and
 * the database — which means a response that has begun streaming will not turn
 * into an error envelope halfway down, a shape no HTTP client can recover from.
 */

export const exportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  /** `title,body,created_at`. Absent = every column, in declaration order. */
  columns: z.string().optional(),
});

export interface ExportPlan {
  filename: string;
  contentType: string;
  rowCount: number;
  write(sink: Writable): Promise<void>;
}

const CONTENT_TYPES: Record<TransferFormat, string> = {
  // `charset=utf-8` is stated even though the BOM already says so: a browser
  // that reads the header and ignores the BOM would otherwise guess.
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Resolves `?columns=` against the resource, preserving **declaration order**
 * rather than the order the caller listed.
 *
 * Two files exported by two users with the same columns in a different order
 * would otherwise have different headers, and neither could be imported by a
 * template built from the other.
 */
function selectColumns(resource: TransferResource, requested: string | undefined): ColumnDef[] {
  if (requested === undefined || requested.trim() === '') return resource.columns;

  const wanted = new Set(
    requested
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c !== ''),
  );

  const unknown = [...wanted].filter((key) => !resource.columns.some((c) => c.key === key));
  if (unknown.length > 0) {
    throw new ValidationError({ columns: [`Unknown column(s): ${unknown.join(', ')}`] });
  }

  const selected = resource.columns.filter((c) => wanted.has(c.key));
  if (selected.length === 0) {
    throw new ValidationError({ columns: ['Select at least one column'] });
  }
  return selected;
}

function parseFilters(resource: TransferResource, query: unknown): TransferFilters {
  if (!resource.filtersSchema) return {};
  const result = resource.filtersSchema.safeParse(query);
  if (!result.success) {
    throw new ValidationError(result.error.flatten().fieldErrors as Record<string, string[]>);
  }
  return result.data as TransferFilters;
}

/**
 * `notes-2026-08-12.csv`.
 *
 * ASCII resource name and an ISO date, deliberately — the localized label would
 * put Arabic in a filename, and `Content-Disposition` filename encoding is
 * inconsistent enough across clients that the safe move is not to need it. The
 * client renames the file for the user if it wants a localized one.
 */
function buildFilename(resource: TransferResource, format: TransferFormat, now: Date): string {
  return `${resource.name}-${now.toISOString().slice(0, 10)}.${format}`;
}

/**
 * `async` even though every check below is synchronous.
 *
 * A function typed `Promise<T>` that throws before its first `await` throws
 * **synchronously**, so half its failures arrive as exceptions at the call site
 * and half as rejections — and any caller that handles only one shape drops the
 * other. `async` makes every refusal a rejection, uniformly.
 */
export async function planExport(
  resource: TransferResource,
  ctx: TransferContext,
  query: unknown,
): Promise<ExportPlan> {
  const parsed = exportQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }
  const { format, columns: requestedColumns } = parsed.data;

  if (!resource.exportFormats.includes(format)) {
    throw new ValidationError({
      format: [`"${format}" is not exportable for "${resource.name}"`],
    });
  }

  const columns = selectColumns(resource, requestedColumns);
  const filters = parseFilters(resource, query);

  return buildPlan(resource, ctx, filters, columns, format);
}

async function buildPlan(
  resource: TransferResource,
  ctx: TransferContext,
  filters: TransferFilters,
  columns: ColumnDef[],
  format: TransferFormat,
): Promise<ExportPlan> {
  const rowCount = await resource.countRows(ctx, filters);

  if (rowCount > resource.maxExportRows) {
    // Refused here, before `readRows` is touched. The alternative — start
    // streaming and hope — holds a database cursor and a connection for minutes
    // and then dies to a proxy timeout, which reaches the user as a truncated
    // file with no error at all. `data` carries both numbers so the client can
    // tell them how much to narrow the filter by.
    throw new PayloadTooLargeError(
      `This export would contain ${rowCount} rows; the limit is ${resource.maxExportRows}`,
      { row_count: rowCount, max_rows: resource.maxExportRows },
      'export_too_large',
    );
  }

  return {
    filename: buildFilename(resource, format, new Date()),
    contentType: CONTENT_TYPES[format],
    rowCount,
    async write(sink: Writable): Promise<void> {
      const rows = resource.readRows(ctx, filters);
      if (format === 'xlsx') {
        await writeXlsx(sink, columns, rows, resource.name);
        return;
      }
      for await (const chunk of csvChunks(columns, rows)) {
        // Respect backpressure: without the drain wait, a fast query into a
        // slow connection buffers the entire export in the socket's write
        // queue — the memory the streaming design exists to avoid.
        if (!sink.write(chunk)) {
          await new Promise<void>((resolve) => sink.once('drain', resolve));
        }
      }
      sink.end();
    },
  };
}
