import ExcelJS from 'exceljs';

/**
 * Reads an uploaded workbook into the same `string[][]` matrix `parseCsv`
 * produces, so `import.service.ts` has one code path for both formats.
 *
 * Flattening XLSX's typed cells back to text is deliberate, not lazy. The
 * alternative — branch on whether the cell arrived typed — means a value
 * imported from a spreadsheet can take a path a value imported from CSV never
 * takes, and the two formats drift into accepting different things. One text
 * matrix, one `parseCell`, one set of rules.
 *
 * Non-streaming (`xlsx.load`) unlike the writer: an upload is already fully
 * buffered by multer and bounded by both a byte limit and a row limit before it
 * reaches here, so there is nothing left for streaming to protect against.
 */

/** Canonical text for one cell, matching what `formatCell` would have written. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // A formula cell: take its computed result, never the formula source. A
    // user's `=A1&B1` should import as what it displays.
    if ('result' in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return String(value.text);
    if ('error' in value) return '';
    return '';
  }
  return String(value);
}

export async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  // The first sheet only. A template has one; a workbook with several is
  // ambiguous, and picking "the one with data" would guess at the user's
  // intent in a way that is wrong silently.
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const matrix: string[][] = [];
  let width = 0;

  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // `row.eachCell` skips empty cells and would shift every later column left
    // by one — a row missing its `body` would import its `created_at` as the
    // body. Index access keeps the positions.
    const count = Math.max(row.cellCount, width);
    for (let i = 1; i <= count; i += 1) {
      cells.push(cellText(row.getCell(i).value).trim());
    }
    if (width === 0) width = cells.length;
    if (cells.some((c) => c !== '')) matrix.push(cells);
  });

  return matrix;
}
