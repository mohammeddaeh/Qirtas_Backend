/**
 * RFC 4180 CSV parser — the exact inverse of `csv.writer.ts`.
 *
 * Hand-written rather than pulled from npm because the job is one state machine
 * and the two halves must provably round-trip: `__tests__/csv.test.ts` asserts
 * that writer output parses back to the input, which a third-party parser with
 * its own quoting opinions would make an approximation rather than a proof.
 *
 * What it handles, because uploaded files really contain all of it: a UTF-8
 * BOM, quoted fields holding commas / quotes / newlines, CRLF and LF and lone
 * CR line endings mixed in one file, and a final line with no terminator.
 */

/** Undoes [guardFormula] so an exported-then-reimported value is unchanged. */
export function unguardFormula(text: string): string {
  if (text.length >= 2 && text[0] === "'") {
    const second = text[1]!;
    if (second === '=' || second === '+' || second === '@' || second === '-') {
      return text.slice(1);
    }
  }
  return text;
}

/**
 * Splits [input] into a matrix of raw cell text. No typing, no header
 * interpretation — that is `import.service.ts`'s job, against the resource's
 * column definitions.
 *
 * Rows that are entirely empty are dropped: a trailing newline, or the blank
 * lines Excel leaves after a deleted range, are not rows the user meant to
 * import, and reporting "row 431: title is required" for them destroys any
 * trust in the error report.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      // Only opens a quoted field at the start of one. A quote appearing
      // mid-field (`ab"cd`) is literal — Excel writes it that way, and treating
      // it as an opener would swallow the rest of the file into one cell.
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // A file that does not end with a newline still has a last row.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}
