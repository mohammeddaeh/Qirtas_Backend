/**
 * Single entry point for every seed step — `npm run db:seed [-- flags]`.
 *
 * The core step (permissions + roles + their ar/en display names) always runs
 * and is idempotent. Everything else is opt-in behind a flag, because those
 * steps differ in kind, not just in scope: `--demo` writes a large dataset and
 * can hard-delete, `--fr` and `--ui-overrides-demo` write translation content
 * that a developer edits by hand in its own file, `--admin` creates a real
 * account. Running them unconditionally on every `db:seed` would be wrong for
 * all four.
 *
 * Each step lives in its own module and exports a plain async function; this
 * file owns argument parsing, ordering, and the single `pool.end()` — the step
 * modules never open or close the connection themselves.
 *
 *   npm run db:seed                          # core only
 *   npm run db:seed -- --admin               # + first Super Admin account
 *   npm run db:seed -- --demo --reset        # + Arabic demo dataset, wiped first
 *   npm run db:seed -- --fr                  # + French dynamic language
 *   npm run db:seed -- --all                 # core + admin + demo + fr
 *   npm run db:setup                         # migrate, then --admin --demo --reset
 */
import { pool } from './client.js';
import { seedCore } from './seed-core.js';
import { bootstrapSuperAdminIfMissing } from './bootstrap-super-admin.js';
import { seedDemoArabicData } from './seed-demo-arabic-data.js';
import { seedFrenchUiTranslations } from './seed-french-ui-translations.js';
import { seedUiTextOverridesDemo } from './seed-ui-text-overrides-demo.js';
import { logger } from '../logger/logger.js';

const KNOWN_FLAGS = [
  '--admin',
  '--demo',
  '--reset',
  '--fr',
  '--ui-overrides-demo',
  '--all',
  '--help',
] as const;

const USAGE = `
Usage: npm run db:seed [-- <flags>]

Always runs:
  (core)                permission catalog + role catalog + permission display
                        names (ar/en). Idempotent.

Optional flags:
  --admin               Create the first Super Admin account if the users table
                        is empty. Credentials from SEED_ADMIN_* env vars —
                        see bootstrap-super-admin.ts for names and defaults.
  --demo                Seed the Arabic demo dataset (15 branches, ~67 users
                        across every role and status) via the real service layer.
  --reset               Only valid with --demo. Hard-deletes the previous demo
                        rows (@qirtas.test users + demo branches by name) first.
  --fr                  Seed the French dynamic language from
                        seed-french-ui-translations.ts.
  --ui-overrides-demo   Seed the ar/en UI-text override demo. DEMO ONLY — it
                        deliberately changes 'welcomeBack' to a visibly
                        different string. Excluded from --all on purpose.
  --all                 Shorthand for --admin --demo --fr (never
                        --ui-overrides-demo, never --reset).
  --help                Print this and exit.
`.trim();

/**
 * A mistake in the command line, not a failure of the seed itself — reported
 * as plain text on stderr rather than through the JSON logger, which would
 * bury the usage block inside a stack-trace object.
 */
class UsageError extends Error {}

interface SeedOptions {
  admin: boolean;
  demo: boolean;
  reset: boolean;
  fr: boolean;
  uiOverridesDemo: boolean;
}

/** Throws on anything unrecognised or contradictory — never silently ignores a flag. */
function parseArgs(argv: string[]): SeedOptions | 'help' {
  const unknown = argv.filter((arg) => !KNOWN_FLAGS.includes(arg as (typeof KNOWN_FLAGS)[number]));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown flag(s): ${unknown.join(', ')}\n\n${USAGE}`);
  }
  if (argv.includes('--help')) return 'help';

  const all = argv.includes('--all');
  const options: SeedOptions = {
    admin: all || argv.includes('--admin'),
    demo: all || argv.includes('--demo'),
    reset: argv.includes('--reset'),
    fr: all || argv.includes('--fr'),
    uiOverridesDemo: argv.includes('--ui-overrides-demo'),
  };

  // --reset only ever means "wipe the demo rows"; on its own it would read as
  // a full database reset, which this script never does.
  if (options.reset && !options.demo) {
    throw new UsageError(`--reset is only valid together with --demo\n\n${USAGE}`);
  }

  return options;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }

  await seedCore();

  if (parsed.admin) {
    await bootstrapSuperAdminIfMissing();
  }
  if (parsed.demo) {
    await seedDemoArabicData({ reset: parsed.reset });
  }
  if (parsed.fr) {
    await seedFrenchUiTranslations();
  }
  if (parsed.uiOverridesDemo) {
    await seedUiTextOverridesDemo();
  }

  logger.info('Seed complete');
}

main()
  .catch((err: unknown) => {
    if (err instanceof UsageError) {
      console.error(err.message);
    } else {
      logger.error({ err }, 'Seed failed');
    }
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
