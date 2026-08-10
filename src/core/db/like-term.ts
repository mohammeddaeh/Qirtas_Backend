/**
 * Builds a case-insensitive `ILIKE` term for a free-text search filter.
 *
 * `%` and `_` are escaped. Unescaped, someone typing `%` matches every row and
 * concludes the search is broken rather than that their input was special — and
 * `_` silently matches any single character, producing results nobody asked
 * for.
 *
 * Callers must skip an empty value before calling: `%%` matches everything,
 * which resembles "no filter" only by accident.
 */
export function likeTerm(raw: string): string {
  const escaped = raw.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}
