import { z } from 'zod';
import {
  registry,
  successEnvelope,
  errorEnvelope,
  commonErrorResponses,
  unauthorizedResponse,
} from '../openapi/registry.js';

/**
 * OpenAPI for `/api/v1/data-transfer/*`.
 *
 * These paths are registered once and serve **every** resource — the `resource`
 * path parameter is the whole generic surface, and its allowed values come from
 * `GET /resources` at runtime rather than from this document. That is the point
 * of the module: a new transferable feature adds a declaration and appears
 * here without a line of OpenAPI.
 *
 * The two download paths are the only ones in this API whose 200 is **not** the
 * success envelope. They are documented as `application/octet-stream` for
 * exactly that reason — see `docs/rest_api.md` §Data transfer, and the warning
 * in `controllers/data-transfer.controller.ts` about what a JSON-parsing client
 * does with a CSV.
 */
const tags = ['Data transfer (import / export)'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

const localizedLabel = z
  .object({ ar: z.string(), en: z.string() })
  .openapi({ example: { ar: 'الملاحظات', en: 'Notes' } });

const transferColumnSchema = z.object({
  key: z.string().openapi({ example: 'title' }),
  label: localizedLabel,
  type: z.enum(['string', 'number', 'boolean', 'date', 'datetime']),
  required: z.boolean(),
  importable: z.boolean(),
  example: z.string().optional().openapi({
    example: '0912345678',
    description:
      'A sample **value**. Written into the generated template’s example row, where its job is to teach the format.',
  }),
  hint: localizedLabel.optional().openapi({
    description:
      'One line on what the column **means**. Shown in the app beside the name, never written to a file. Distinct from `example`, which is a value — the app was showing a sample value where an explanation belonged.',
  }),
});

const transferFilterSchema = z.object({
  key: z.string().openapi({
    example: 'search',
    description: 'Query-string key, sent verbatim on `/export`.',
  }),
  label: localizedLabel,
  type: z.enum(['text', 'select', 'boolean']),
  placeholder: localizedLabel.optional(),
  options: z
    .array(z.object({ value: z.string(), label: localizedLabel }))
    .optional()
    .openapi({ description: 'Required for `select`.' }),
});

const transferResourceSchema = z.object({
  name: z.string().openapi({ example: 'notes' }),
  label: localizedLabel,
  export_formats: z.array(z.enum(['csv', 'xlsx'])),
  import_formats: z.array(z.enum(['csv', 'xlsx'])),
  max_export_rows: z.number().int().openapi({ example: 50_000 }),
  supports_import: z.boolean(),
  columns: z.array(transferColumnSchema),
  filters: z.array(transferFilterSchema).openapi({
    description:
      'Filter controls the export screen renders, and the query keys it sends. Empty = no filters.\n\n**Declared, not guessed.** The client used to ship a hardcoded `?q=` box; the first application that named its filter `search` got a control that sent an ignored parameter and filtered nothing, with no error anywhere.',
  }),
});

const importRowErrorSchema = z.object({
  row: z.number().int().openapi({
    example: 12,
    description: '1-based **data** row — the first row under the header is 1, not 2.',
  }),
  column: z.string().nullable().openapi({
    example: 'title',
    description: 'Column key, or null for a whole-row rule. With `row`, this is a cell.',
  }),
  code: z.string().openapi({
    example: 'duplicate_in_file',
    description:
      'Machine-readable. Engine codes: `required`, `invalid_number`, `invalid_boolean`, `invalid_date`, `invalid_date_format`, `duplicate_in_file`, `duplicate_in_database`. A resource’s own zod schema adds its codes on top.',
  }),
  message: z.string(),
  value: z.string().optional().openapi({ description: 'The offending cell as it appeared.' }),
  severity: z.enum(['error', 'warning']).openapi({
    description:
      '`error` — the row cannot be imported until the user changes something. `warning` — the row is being left out by policy (a duplicate under `onDuplicate: skip`), not by mistake. The grid tints the two differently.',
  }),
  duplicate_of_row: z.number().int().optional().openapi({
    description: 'For `duplicate_in_file`: the earlier row it collides with.',
  }),
});

const importValidateReportSchema = z.object({
  token: z
    .string()
    .nullable()
    .openapi({
      example: 'imp_9f2c…',
      description:
        'Spend this on `?mode=commit`. `null` when no row was valid — there is nothing to confirm.',
    }),
  expires_in: z.number().int().openapi({ example: 900 }),
  total_rows: z.number().int(),
  valid_rows: z.number().int(),
  errors: z.array(importRowErrorSchema),
  truncated_errors: z.boolean().openapi({
    description: 'true when the error list was capped at 200 — "the first 200 of many".',
  }),
  columns: z.array(z.string()).openapi({
    example: ['title', 'body'],
    description: 'The importable column keys found in the file, in declared order — the grid’s headers.',
  }),
  rows: z.array(z.record(z.string())).openapi({
    description:
      '**Every row of the file as raw text**, valid and invalid alike — the grid’s body. Echoing the user’s own data back is what lets the client paint the failing cells red instead of printing a list of line numbers. Raw text, not coerced values: what they typed is what they must edit.',
  }),
  truncated_rows: z.boolean().openapi({
    description:
      'true when the file exceeded 2 000 rows and `rows` is empty — the client then shows the error list without a grid, rather than a grid silently missing rows.',
  }),
});

const importCommitReportSchema = z.object({
  inserted: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
});

const fileResponse = (description: string) => ({
  description,
  content: {
    'text/csv': { schema: z.string().openapi({ type: 'string', format: 'binary' }) },
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
      schema: z.string().openapi({ type: 'string', format: 'binary' }),
    },
  },
});

const tooLargeResponse = {
  413: {
    description:
      'The export or upload exceeds its row limit. `data` carries `row_count` and `max_rows` so the client can say how much to narrow by.',
    ...jsonBody(errorEnvelope),
  },
} as const;

registry.registerPath({
  method: 'get',
  path: '/api/v1/data-transfer/resources',
  tags,
  summary: 'What this application can import and export',
  description:
    'The descriptor the client builds its entire import/export UI from — column pickers, format choices and error tables all render from this. A feature that declares a transfer resource appears here with no client change.',
  responses: {
    200: {
      description: 'Every registered resource',
      ...jsonBody(successEnvelope(z.object({ resources: z.array(transferResourceSchema) }))),
    },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/data-transfer/{resource}/export',
  tags,
  summary: 'Download the caller’s rows as a file',
  description:
    '**Answers file bytes, not the success envelope** — a client that parses every 200 as JSON will report an error over a perfectly good CSV. Download it as bytes. Errors still answer the envelope, and all of them occur before the first byte is written, so the status line tells the two apart.\n\n`?columns=` selects a subset (declaration order is always preserved, whatever order is requested). Any further query parameter is passed to the resource’s own filter schema — `?q=` for notes. CSV is written with a UTF-8 BOM so Arabic opens correctly in Excel.',
  request: {
    query: z.object({
      format: z.enum(['csv', 'xlsx']).default('csv'),
      columns: z
        .string()
        .optional()
        .openapi({ example: 'title,body', description: 'Comma-separated. Omit for every column.' }),
    }),
  },
  responses: {
    200: fileResponse('The exported file. `X-Row-Count` carries the row total.'),
    ...unauthorizedResponse,
    ...tooLargeResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/data-transfer/{resource}/template',
  tags,
  summary: 'Download an empty file shaped the way the importer expects',
  description:
    'Importable columns only, with one example row. Removes the entire class of failure caused by a user building a spreadsheet from a screenshot of the column list. Answers file bytes, like `export`.',
  request: { query: z.object({ format: z.enum(['csv', 'xlsx']).default('xlsx') }) },
  responses: {
    200: fileResponse('The template file'),
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/data-transfer/{resource}/import',
  tags,
  summary: 'Import rows — validate first, then commit',
  description:
    'Two phases on one path, selected by `?mode=`.\n\n**`mode=validate`** (default) accepts **either** body:\n\n- `multipart/form-data` with a single `file` part (≤ 5 MB, ≤ 10 000 rows, `.csv` or `.xlsx`) — the first upload;\n- `application/json` with `{ columns, rows }` — the **same file after the user fixed cells in the app**.\n\nBoth run the identical rules through one code path. A separate re-validate endpoint would be a second copy of them, and the copies would drift until the grid accepted rows the upload refused.\n\nEither way the answer is a row-by-row report *plus every row of the file*, so the client can render the data as a grid and paint the failing cells red. Nothing is written.\n\n**`mode=commit`** takes `{ "token": "imp_…" }` and writes every staged row inside one transaction — all of them or none. The token is consumed on use, so a retry re-uploads rather than replaying a payload whose effect is now unknown.\n\nThe split exists so a file with three bad rows out of five hundred does not force a choice between writing 497 rows the user cannot identify and refusing all 500 without saying why.',
  request: {
    query: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }),
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ file: z.string().openapi({ type: 'string', format: 'binary' }) }),
        },
        'application/json': {
          schema: z.union([
            z
              .object({
                columns: z.array(z.string()),
                rows: z.array(z.record(z.string())),
              })
              .openapi({ description: '`mode=validate` — rows edited in the app.' }),
            z.object({ token: z.string() }).openapi({ description: '`mode=commit`.' }),
          ]),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'A validation report (`mode=validate`) or the commit counts (`mode=commit`)',
      content: {
        'application/json': {
          schema: successEnvelope(
            z.union([importValidateReportSchema, importCommitReportSchema]),
          ),
        },
      },
    },
    ...unauthorizedResponse,
    ...tooLargeResponse,
    ...commonErrorResponses,
  },
});
