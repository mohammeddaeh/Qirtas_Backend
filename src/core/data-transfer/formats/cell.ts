import type { ColumnType, TransferCell } from '../types.js';

/**
 * The single place a cell crosses between a typed value and text.
 *
 * [formatCell] and [parseCell] are a matched pair and are tested as one
 * (`__tests__/cell.test.ts`): whatever the exporter writes, the importer must
 * read back to the same value. Kept in one file so a change to one side cannot
 * be made without seeing the other — the round trip is the contract, not either
 * function alone.
 *
 * XLSX carries real types and mostly bypasses [parseCell]; CSV is text all the
 * way down and does not. Both go through [formatCell] on the way out so the two
 * files a user can download are the same data.
 */

/** Successful parse, or a `code` for [ImportRowError.code]. */
export type CellParseResult =
  | { ok: true; value: string | number | boolean | Date | null }
  | { ok: false; code: string };

/**
 * Arabic-Indic (٠١٢…) and Extended Arabic-Indic (۰۱۲…) digits → ASCII.
 *
 * A user on an Arabic Windows locale gets these from Excel without ever having
 * typed them, and `Number('١٢٣')` is `NaN` — so the row is refused with
 * "invalid number" over a value that is plainly a number on screen. That
 * refusal is unexplainable to the person reading it, which is why the
 * normalisation happens here rather than being left to each resource.
 */
function normaliseDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export function formatCell(value: TransferCell, type: ColumnType): string {
  if (value === null || value === undefined) return '';

  switch (type) {
    case 'boolean':
      // `true`/`false`, not `1`/`0`: the file is read by people as often as by
      // machines, and `0` in a column called "active" is read as a quantity.
      return value === true || value === 1 || value === '1' || value === 'true'
        ? 'true'
        : 'false';

    case 'number':
      return typeof value === 'number' ? String(value) : String(value ?? '');

    case 'date':
      // Date-only, in UTC. `toISOString().slice(0,10)` and not a local-time
      // formatter: the server's timezone is not the user's, and a date rendered
      // through it lands a day off for anyone east or west of it.
      return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

    case 'datetime':
      return value instanceof Date ? value.toISOString() : String(value);

    case 'string':
    default:
      return String(value);
  }
}

export function parseCell(raw: string, type: ColumnType): CellParseResult {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };

  switch (type) {
    case 'string':
      return { ok: true, value: text };

    case 'number': {
      // Thousands separators — ASCII comma, Arabic U+066C, and any space —
      // are stripped before parsing; they are display artefacts of the same
      // number. U+00A0 and U+202F are written as escapes rather than typed:
      // Excel emits both in several locales, and a literal no-break space is
      // invisible in an editor, so nobody reading this line could tell what it
      // strips.
      const cleaned = normaliseDigits(text)
        .replace(/[,٬\s\u00a0\u202f]/g, '')
        .replace(/٫/g, '.'); // Arabic decimal separator
      const n = Number(cleaned);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, code: 'invalid_number' };
    }

    case 'boolean': {
      const t = text.toLowerCase();
      if (['true', '1', 'yes', 'y', 'نعم', 'صح'].includes(t)) return { ok: true, value: true };
      if (['false', '0', 'no', 'n', 'لا', 'خطأ'].includes(t)) return { ok: true, value: false };
      return { ok: false, code: 'invalid_boolean' };
    }

    case 'date':
    case 'datetime': {
      const normalised = normaliseDigits(text);
      // ISO only — `2026-08-12` or a full `2026-08-12T09:30:00Z`.
      //
      // `03/04/2026` is deliberately refused rather than guessed. It is April
      // 3rd to most of the world and March 4th in the United States, and
      // `new Date()` picks one without saying which. A wrong-but-accepted date
      // is worse than a rejected one: the import succeeds and the error is
      // found months later in a report.
      if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(normalised)) {
        return { ok: false, code: 'invalid_date_format' };
      }
      const d = new Date(type === 'date' ? `${normalised.slice(0, 10)}T00:00:00Z` : normalised);
      return Number.isNaN(d.getTime())
        ? { ok: false, code: 'invalid_date' }
        : { ok: true, value: d };
    }

    default:
      return { ok: true, value: text };
  }
}
