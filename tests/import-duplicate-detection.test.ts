/**
 * Guards the one import check whose failure is **invisible on both sides**.
 *
 * `flagDatabaseDuplicates` compares a key the engine normalises in JavaScript
 * (`duplicateKey`: trim, lower-case, collapse whitespace) against a key the
 * database normalises in SQL. Two normalisations, two languages, one string
 * that has to come out identical — and nothing anywhere fails when they drift.
 *
 * ## What drifting looks like
 *
 * Not an error. The query still runs, still returns rows, and still matches
 * every name whose spacing was already canonical — which is nearly all of them,
 * so the feature looks correct in every casual test. Only a name the engine had
 * to *change* (double space, tab, trailing blank) stops matching, and that row
 * is then reported as new: **the review screen shows no problem at all**, the
 * user confirms an import they were told was clean, and the write dies at the
 * unique index — after the single-use staging token has been spent. What
 * reached the user was "this import has expired or was already used", about a
 * file they had just uploaded (reported 2026-08-13; the SQL said `'\s+'` inside
 * a JavaScript template literal, so Postgres received `'s+'` — the letter s).
 *
 * ## Why each case, and why its opposite
 *
 * Proving that "فرع  مركز" is caught proves nothing on its own: a function that
 * flagged every row as a duplicate would pass it, and that function turns a
 * working import into a screen of red cells. So the file it does not flag is
 * asserted in the same run. And the canonical-spacing case is here because it
 * is the one that **kept passing while the feature was broken** — a suite
 * containing only that case is a suite that would have shipped this bug.
 *
 * Read-only except for one branch, created and removed in `finally`
 * (docs/scripts.md — the standing rule for this suite).
 *
 * Run: `npm run test:import`
 */
import { pool } from '../src/core/db/client.js';
import { branchesTransferResource } from '../src/features/identity/branches.transfer.js';
import { validateImport } from '../src/core/data-transfer/services/import.service.js';
import * as branchesRepository from '../src/features/identity/repositories/branches.repository.js';
import { duplicateKey } from '../src/core/data-transfer/types.js';
import type { ImportValidateReport } from '../src/core/data-transfer/services/import.service.js';

let pass = 0;
let fail = 0;
const chk = (name: string, ok: boolean, detail = ''): void => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  [${detail}]` : ''}`);
};

// Run-unique: a leftover from a half-finished earlier run must not make this
// one fail for a reason that has nothing to do with normalisation.
const runTag = `${Date.now()}`;
/** Two spaces in the middle — the shape the engine has to normalise and the database does not. */
const SPACED_NAME = `فرع  اختبار ${runTag}`;
/** Single spaces — canonical on both sides. The case that passed all along. */
const CANONICAL_NAME = `فرع اختبار ثانٍ ${runTag}`;
const NEW_NAME = `فرع غير موجود ${runTag}`;

/** One row, as a CSV upload — the same path the app takes. */
function validateOneName(name: string): Promise<ImportValidateReport> {
  const csv = `name,address,contact_info\n${name},عنوان,0912345678\n`;
  return validateImport(
    branchesTransferResource,
    { userId: 1 },
    { buffer: Buffer.from(csv, 'utf8'), originalname: 'test.csv' },
    'csv',
  );
}

const isDuplicateReport = (report: ImportValidateReport): boolean =>
  report.token === null &&
  report.valid_rows === 0 &&
  report.errors.some((e) => e.code === 'duplicate_in_database' && e.severity === 'error');

const createdIds: number[] = [];

try {
  for (const name of [SPACED_NAME, CANONICAL_NAME]) {
    const { rows } = await pool.query<{ id: number }>(
      'INSERT INTO branches (name) VALUES ($1) RETURNING id',
      [name],
    );
    createdIds.push(rows[0]!.id);
  }

  // ── The lookup itself ─────────────────────────────────────────────────────
  // Asserted separately from the report because a mismatch here is the actual
  // defect; the report is how it reaches a user.
  const spacedKey = duplicateKey({ name: SPACED_NAME }, ['name']);
  chk(
    'duplicateKey collapses the double space (the premise of everything below)',
    spacedKey === SPACED_NAME.replace(/\s+/g, ' ') && spacedKey !== SPACED_NAME,
    spacedKey,
  );

  const foundSpaced = await branchesRepository.findExistingNames([spacedKey]);
  chk(
    'findExistingNames matches a stored name whose spacing the engine normalised',
    foundSpaced.has(spacedKey),
    `${foundSpaced.size} matched`,
  );

  const foundCanonical = await branchesRepository.findExistingNames([
    duplicateKey({ name: CANONICAL_NAME }, ['name']),
  ]);
  chk(
    'findExistingNames matches a stored name that needed no normalising',
    foundCanonical.size === 1,
    `${foundCanonical.size} matched`,
  );

  // The opposite: a lookup that answered "everything exists" would satisfy both
  // assertions above and refuse every legitimate import.
  const foundNew = await branchesRepository.findExistingNames([
    duplicateKey({ name: NEW_NAME }, ['name']),
  ]);
  chk(
    'findExistingNames does NOT match a name nobody has used',
    foundNew.size === 0,
    `${foundNew.size} matched`,
  );

  // ── What the user sees ────────────────────────────────────────────────────
  chk(
    'validate refuses a re-upload of the irregularly-spaced name, and issues no token',
    isDuplicateReport(await validateOneName(SPACED_NAME)),
  );

  chk(
    'validate refuses a re-upload of the canonically-spaced name too',
    isDuplicateReport(await validateOneName(CANONICAL_NAME)),
  );

  // Same file shape, name that does not exist: a token IS issued and no
  // duplicate is reported. Without this, "flag everything" passes the suite.
  const fresh = await validateOneName(NEW_NAME);
  chk(
    'validate accepts a genuinely new name — token issued, one valid row, no duplicate error',
    fresh.token !== null &&
      fresh.valid_rows === 1 &&
      !fresh.errors.some((e) => e.code === 'duplicate_in_database'),
    `token=${fresh.token === null ? 'null' : 'issued'} valid=${fresh.valid_rows} errors=${fresh.errors.length}`,
  );

  // The staging row that `fresh` just wrote is never committed here; it expires
  // on its own and the next validate sweeps it (see stageRows).
  if (fresh.token !== null) {
    await pool.query('DELETE FROM import_staging WHERE token = $1', [fresh.token]);
  }
} finally {
  if (createdIds.length > 0) {
    try {
      await pool.query('DELETE FROM branches WHERE id = ANY($1::int[])', [createdIds]);
      console.log(`🧹 removed ${createdIds.length} test branch(es)`);
    } catch (err) {
      // Reported, not swallowed: a leftover holds the unique name index and the
      // next run would fail for a reason unrelated to normalisation.
      console.error('⚠️  cleanup failed — remove these branches manually:', createdIds, err);
    }
  }
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
