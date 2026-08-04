/**
 * Helpers shared by every seed step under this directory.
 *
 * `ensureLanguageExists` used to be copy-pasted verbatim into three separate
 * seed scripts (permission translations, French UI, UI text overrides demo) —
 * it lives here now so the "create the `languages` row only if missing" rule
 * has exactly one implementation.
 */
import * as languagesRepository from '../../features/localization/repositories/languages.repository.js';
import { logger } from '../logger/logger.js';

/**
 * The two compile-time languages of the Flutter app. Rows are created in the
 * `languages` table not to serve regular UI text (that stays compile-time —
 * docs/reference/dynamic_localization.md §5 "Model 2") but so
 * `translation_entries` has a valid FK target for the `permission.*` keys and
 * for any deliberate remote override (§13, §15).
 */
export const BUNDLED_LANGUAGES: { code: string; name: string; is_rtl: boolean }[] = [
  { code: 'ar', name: 'العربية', is_rtl: true },
  { code: 'en', name: 'English', is_rtl: false },
];

/**
 * Email domain that marks a row as owned by the demo seed. Lives here rather
 * than inside `seed-demo-arabic-data.ts` because `bootstrap-super-admin.ts`
 * must also know it: `--demo --reset` hard-deletes every user carrying this
 * suffix, so the Super Admin must never be created under it.
 */
export const DEMO_EMAIL_SUFFIX = '@qirtas.test';

/**
 * Creates the `languages` row for `code` only when it does not already exist.
 * Never updates an existing row — `name`/`is_rtl` here are bookkeeping for the
 * row's own creation, not a source of truth to re-apply on every run.
 */
export async function ensureLanguageExists(
  code: string,
  name: string,
  is_rtl: boolean,
  context: string,
): Promise<void> {
  const existing = await languagesRepository.findByCode(code);
  if (existing) return;
  await languagesRepository.insert({ code, name, is_rtl, is_active: true });
  logger.info(`Created languages row for "${code}" (${context} prerequisite)`);
}

/** Convenience wrapper — ensures both bundled languages (ar + en) exist. */
export async function ensureBundledLanguagesExist(context: string): Promise<void> {
  for (const language of BUNDLED_LANGUAGES) {
    await ensureLanguageExists(language.code, language.name, language.is_rtl, context);
  }
}
