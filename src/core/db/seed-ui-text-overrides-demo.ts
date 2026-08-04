/**
 * ⚠️ DEMO / EXAMPLE SCRIPT — NOT a required production seed.
 *
 * This proves, end-to-end, that the "Local-First with Remote Override"
 * mechanism (docs/reference/dynamic_localization.md §15) actually works: a
 * regular UI text key that ALREADY has a compile-time base value in the
 * Flutter app's `ar.json`/`en.json` (unlike `permission.*` keys, which never
 * had a static value to begin with — see §13) can ALSO get a
 * `translation_entries` row for `ar`/`en`, and that row overrides the
 * compile-time value once the frontend's `DynamicAwareAssetLoader` merges it
 * in.
 *
 * This is NOT how a real admin would manage UI text overrides day-to-day —
 * that would go through a future admin UI, or direct
 * `PUT /api/v1/languages/:code/translations` calls. This script exists only
 * to seed a small, deterministic, re-runnable example so the mechanism can be
 * exercised/tested without needing that future admin UI to exist yet.
 *
 * Overrides exactly one key (`welcomeBack`) for both `ar` and `en`, with text
 * that is deliberately DIFFERENT from the compile-time base
 * (`assets/translations/ar.json`/`en.json` in the Flutter app) so the
 * override is visibly distinguishable when testing.
 *
 * Safe to re-run any number of times — upserts by (language_code, key) via
 * `translation-entries.repository.ts` `upsertMany`, exactly like the core
 * seed's permission display names and `seed-french-ui-translations.ts`. Run:
 *   npm run db:seed -- --ui-overrides-demo
 * Deliberately excluded from `--all` — it changes visible UI text.
 *
 * To remove the demo effect: either overwrite `welcomeBack` again via
 * `PUT /:code/translations` with the original base text, or deactivate/delete
 * the `translation_entries` row directly — this script has no "undo" mode by
 * design (matches the other seed steps in this directory).
 *
 * Invoked by the orchestrator in `seed.ts`; this module never opens or closes
 * the pool.
 */
import { BUNDLED_LANGUAGES, ensureBundledLanguagesExist } from './seed-shared.js';
import * as languagesRepository from '../../features/localization/repositories/languages.repository.js';
import * as translationEntriesRepository from '../../features/localization/repositories/translation-entries.repository.js';
import { logger } from '../logger/logger.js';

/**
 * Demo overrides — deliberately different from the compile-time base text
 * ("مرحبًا بك مرة أخرى" / "Welcome back" in ar.json/en.json) so the override
 * is unmistakable when testing. Add more keys here only for further manual
 * testing of this mechanism — this is not meant to grow into a real seed.
 */
const UI_TEXT_OVERRIDES_DEMO: Record<string, { ar: string; en: string }> = {
  welcomeBack: {
    ar: 'أهلاً بعودتك (نسخة محدّثة من الخادم)',
    en: 'Welcome back (server-updated demo copy)',
  },
};

export async function seedUiTextOverridesDemo(): Promise<void> {
  await ensureBundledLanguagesExist('ui-text-overrides-demo');

  for (const language of BUNDLED_LANGUAGES) {
    const code = language.code as 'ar' | 'en';
    const entries: Record<string, string> = {};
    for (const [key, values] of Object.entries(UI_TEXT_OVERRIDES_DEMO)) {
      entries[key] = values[code];
    }
    await translationEntriesRepository.upsertMany(language.code, entries);
    await languagesRepository.incrementVersion(language.code);
  }

  logger.info(
    `Seeded ${Object.keys(UI_TEXT_OVERRIDES_DEMO).length} UI text override(s) (ar + en) — DEMO ONLY, see file header comment`,
  );
}
