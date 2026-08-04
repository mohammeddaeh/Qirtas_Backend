import { NotFoundError, BusinessError } from '../../../core/http/api-error.js';
import * as languagesRepository from '../repositories/languages.repository.js';
import * as translationEntriesRepository from '../repositories/translation-entries.repository.js';
import {
  toWireLanguage,
  type WireLanguage,
  type CreateLanguageBody,
  type UpdateLanguageBody,
} from '../dtos/languages.dto.js';
import type { WireTranslations } from '../dtos/translations.dto.js';

/** Active languages only — what the app's startup poll (GET /languages) is allowed to see. */
export async function listActiveLanguages(): Promise<WireLanguage[]> {
  const rows = await languagesRepository.findAllActive();
  return rows.map(toWireLanguage);
}

/** Admin listing (includes inactive languages) — used by the management screens, not the app poll. */
export async function getLanguageByCode(code: string): Promise<WireLanguage> {
  const row = await languagesRepository.findByCode(code);
  if (!row) throw new NotFoundError('Language not found');
  return toWireLanguage(row);
}

export async function createLanguage(body: CreateLanguageBody): Promise<WireLanguage> {
  const existing = await languagesRepository.findByCode(body.code);
  if (existing) {
    throw new BusinessError(409, `Language "${body.code}" already exists`);
  }
  const row = await languagesRepository.insert({
    code: body.code,
    name: body.name,
    is_rtl: body.is_rtl,
  });
  return toWireLanguage(row);
}

export async function updateLanguage(code: string, body: UpdateLanguageBody): Promise<WireLanguage> {
  const existing = await languagesRepository.findByCode(code);
  if (!existing) throw new NotFoundError('Language not found');

  const row = await languagesRepository.update(code, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.is_rtl !== undefined ? { is_rtl: body.is_rtl } : {}),
  });
  if (!row) throw new NotFoundError('Language not found');
  return toWireLanguage(row);
}

export async function deactivateLanguage(code: string): Promise<WireLanguage> {
  const existing = await languagesRepository.findByCode(code);
  if (!existing) throw new NotFoundError('Language not found');

  const row = await languagesRepository.setActive(code, false);
  if (!row) throw new NotFoundError('Language not found');
  return toWireLanguage(row);
}

/** 404s for both "unknown code" and "deactivated" — the app must not distinguish the two (see localization.routes.ts). */
export async function getActiveTranslations(code: string): Promise<WireTranslations> {
  const language = await languagesRepository.findByCode(code);
  if (!language || !language.is_active) throw new NotFoundError('Language not found');

  const rows = await translationEntriesRepository.findByLanguage(code);
  const translations: Record<string, string> = {};
  for (const row of rows) {
    translations[row.key] = row.value;
  }
  return { code: language.code, version: language.version, translations };
}

/** Upserts translation entries then bumps the language's version — the cache-invalidation signal GET /languages exposes. */
export async function replaceTranslations(
  code: string,
  entries: Record<string, string>,
): Promise<WireLanguage> {
  const existing = await languagesRepository.findByCode(code);
  if (!existing) throw new NotFoundError('Language not found');

  await translationEntriesRepository.upsertMany(code, entries);
  const row = await languagesRepository.incrementVersion(code);
  if (!row) throw new NotFoundError('Language not found');
  return toWireLanguage(row);
}
