/**
 * Environment for the unit/contract suite. Loaded by `vitest.config.ts` before
 * any test file is imported.
 *
 * ## Why this file has to exist
 *
 * `env.ts` validates at **module load** and calls `process.exit(1)` when
 * `DATABASE_URL` is missing. That is right for a server — a process that boots
 * with a broken configuration and discovers it on the first request is far
 * worse. But it also means importing anything that transitively reaches
 * `auth-config.ts` — which is every DTO, because the password policy lives
 * there — kills the test runner before a single assertion runs.
 *
 * The first attempt at a unit suite here failed exactly that way. The value
 * below is a **placeholder that is never dialled**: the unit suite touches no
 * database, and the integration suite (`*.int.test.ts`, separate config) reads
 * the real `.env`.
 *
 * ## Why not relax `env.ts` instead
 *
 * Making the schema lenient, or deferring validation until first use, would
 * trade a loud failure at boot for a quiet one mid-request — the property
 * that makes the current design correct. A test-only entry point costs one
 * file and changes nothing about how the server behaves.
 */

// Only fills gaps, so a developer running the unit suite with a real `.env`
// present keeps their own values.
process.env.DATABASE_URL ??= 'postgres://unit-test:unit-test@127.0.0.1:5432/never-connected';
process.env.NODE_ENV ??= 'test';
// `fatal`, not `silent` — pino accepts the latter, this project's env schema
// does not, and finding that out cost one confusing red run.
process.env.LOG_LEVEL ??= 'fatal';

/**
 * Pinned rather than left to default, so an assertion about password length is
 * asserting a fixed rule and not whatever the ambient environment happens to
 * say.
 */
process.env.PASSWORD_MIN_LENGTH ??= '8';
process.env.EMAIL_VERIFICATION_MODE ??= 'required';
