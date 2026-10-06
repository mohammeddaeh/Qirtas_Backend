/**
 * The branch's code as the start of every number it issues (`system_settings.md`).
 *
 * The code is a column the admin sets at creation and keeps unique — the old
 * rule derived it from the first two Latin letters of the name, and two branches
 * («Mazzeh», «Malki») shared `MA`. `BR<id>` is the fallback for a row read
 * before the column existed; the migration gives every branch that same value.
 *
 * In `core/` because every branch-numbered document starts with it (sales,
 * returns and orders in `sales`, print orders in `printing`).
 */
export function branchPrefix(code: string | null | undefined, branchId: number): string {
  const clean = (code ?? '').trim().toUpperCase();
  return clean.length > 0 ? clean : `BR${branchId}`;
}
