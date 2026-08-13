import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import { guardFormula } from './csv.writer.js';
import type { ColumnDef, TransferRow } from '../types.js';

/**
 * XLSX via exceljs' **streaming** workbook writer.
 *
 * `WorkbookWriter`, not the ordinary `Workbook`: the latter builds the entire
 * sheet in memory and serialises at the end, which at the 50 000-row cap is
 * hundreds of megabytes of JS objects per concurrent request. The streaming
 * writer commits each row to the output as it is added, so memory stays flat
 * whatever the row count — the same property the CSV generator has.
 *
 * Unlike CSV, XLSX carries real cell types, so numbers sort as numbers and
 * dates format in the reader's locale without anyone parsing text. The one
 * thing it does **not** get for free is formula safety — see below.
 */

/** Column width in characters. Enough that ISO timestamps and short titles are readable without auto-fit, which the streaming writer cannot do. */
const DEFAULT_COLUMN_WIDTH = 22;

function cellValue(row: TransferRow, column: ColumnDef): string | number | boolean | Date | null {
  const raw = row[column.key];
  if (raw === null || raw === undefined) return null;

  switch (column.type) {
    case 'number':
      return typeof raw === 'number' ? raw : Number(raw);
    case 'boolean':
      return raw === true || raw === 1 || raw === 'true';
    case 'date':
    case 'datetime':
      return raw instanceof Date ? raw : new Date(String(raw));
    case 'string':
    default:
      // The same neutralisation CSV gets. A spreadsheet does not become safe by
      // being binary: a string cell beginning `=` is evaluated as a formula in
      // XLSX exactly as it is in CSV, and this is the more likely file for a
      // user to open, not the less.
      return guardFormula(String(raw));
  }
}

/**
 * Writes the whole workbook into [sink] and resolves when it is finished.
 *
 * Takes a `Writable` rather than an express `Response` so the service layer
 * stays testable against a memory stream — see `__tests__/xlsx.test.ts`.
 */
export async function writeXlsx(
  sink: Writable,
  columns: ColumnDef[],
  rows: AsyncIterable<TransferRow>,
  sheetName = 'Data',
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: sink,
    useStyles: true,
    useSharedStrings: false,
  });

  // exceljs refuses several characters in a sheet name and throws mid-stream if
  // given one — by which point headers are already sent and the failure reaches
  // the user as a truncated download.
  //
  // `views` is passed as an option, not assigned afterwards: on the streaming
  // `WorksheetWriter` (unlike the in-memory `Worksheet`) it is a getter with no
  // setter, and `sheet.views = […]` throws `Cannot set property views`.
  const sheet = workbook.addWorksheet(sheetName.replace(/[*?:/\\[\]]/g, '_').slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = columns.map((c) => ({
    // The wire `key` again, for the same reason as CSV: the file round-trips,
    // and a header that follows the caller's language makes a file exported in
    // one session unimportable in another.
    header: c.key,
    key: c.key,
    width: DEFAULT_COLUMN_WIDTH,
    style:
      c.type === 'date'
        ? { numFmt: 'yyyy-mm-dd' }
        : c.type === 'datetime'
          ? { numFmt: 'yyyy-mm-dd hh:mm:ss' }
          : {},
  }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.commit();

  for await (const row of rows) {
    sheet.addRow(columns.map((c) => cellValue(row, c))).commit();
  }

  sheet.commit();
  await workbook.commit();
}
