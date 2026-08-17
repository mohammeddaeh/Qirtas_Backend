import { defineConfig } from 'vitest/config';

/**
 * Two suites, deliberately separated by what they need to run:
 *
 * - **Unit / contract** (`src/**\/*.test.ts`) — pure functions, zod schemas and
 *   wire shapes. No database, no network, no `.env`. These run in CI on every
 *   push, and they are the half that would have caught the `data.user` vs
 *   `data.account` defect this suite was added because of.
 *
 * - **Integration** (`src/**\/*.int.test.ts`) — a real Postgres and a booted
 *   app. Excluded from the default run and from CI, because a suite that needs
 *   infrastructure nobody has provisioned fails for the wrong reason, and a
 *   suite that fails for the wrong reason stops being read. Run them locally
 *   with `npm run test:int` after `docker compose up -d`.
 *
 * The split is the point. A template that shipped one combined suite would
 * ship a red CI on the first clone.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.int.test.ts'],
    environment: 'node',
    // Runs before any test file is imported. Required, not optional: `env.ts`
    // validates at module load and calls `process.exit(1)` on a missing
    // DATABASE_URL, so without this the runner dies during collection — see
    // that file for why relaxing `env.ts` would be the wrong fix.
    setupFiles: ['src/core/config/test-env.ts'],
    // The engine's rules are what these assert; a test that needs longer than
    // this is doing something it should not.
    testTimeout: 10_000,
  },
});
