import type { Writable } from 'node:stream';
import { z } from 'zod';
import { BusinessError, ValidationError } from '../../http/api-error.js';
import { csvFromRows } from '../formats/csv.writer.js';
import { writeXlsx } from '../formats/xlsx.writer.js';
import type { TransferFormat, TransferResource, TransferRow } from '../types.js';

/**
 * `GET /:resource/template` — an empty file with the right header and one
 * example row.
 *
 * It exists because the alternative is a user constructing a spreadsheet from a
 * screenshot of the column list. Every mismatch that produces — a translated
 * header, a missing required column, a guessed date format — becomes an error
 * report they have to decode. Downloading the shape the importer wants removes
 * the entire class.
 *
 * Only **importable** columns appear. A template carrying `id` and `created_at`
 * invites the user to fill them in and then be told they are ignored.
 */

export const templateQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx']).default('xlsx'),
});

export interface TemplatePlan {
  filename: string;
  contentType: string;
  write(sink: Writable): Promise<void>;
}

const CONTENT_TYPES: Record<TransferFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export async function planTemplate(
  resource: TransferResource,
  query: unknown,
): Promise<TemplatePlan> {
  if (!resource.import) {
    throw new BusinessError(400, `"${resource.name}" does not support import`);
  }

  const parsed = templateQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }
  const { format } = parsed.data;

  if (!resource.importFormats.includes(format)) {
    throw new ValidationError({ format: [`"${format}" is not importable for "${resource.name}"`] });
  }

  const columns = resource.columns.filter((c) => c.importable);

  // One example row, from each column's declared `example`. A template with no
  // sample row leaves the user guessing whether a date is `2026-08-12` or
  // `12/08/2026` — and the importer refuses the second on purpose, so the
  // guess is expensive.
  const example: TransferRow = Object.fromEntries(
    columns.map((c) => [c.key, c.example ?? (c.required ? `<${c.key}>` : '')]),
  );

  return {
    filename: `${resource.name}-template.${format}`,
    contentType: CONTENT_TYPES[format],
    async write(sink: Writable): Promise<void> {
      if (format === 'xlsx') {
        await writeXlsx(
          sink,
          columns,
          (async function* () {
            yield example;
          })(),
          `${resource.name}-template`,
        );
        return;
      }
      sink.end(csvFromRows(columns, [example]));
    },
  };
}
