import { BusinessError } from '../../../core/http/api-error.js';
import * as permissionsRepository from '../repositories/permissions.repository.js';
import * as languagesRepository from '../../localization/repositories/languages.repository.js';
import * as translationEntriesRepository from '../../localization/repositories/translation-entries.repository.js';
import {
  toWirePermission,
  type WirePermission,
  type CreatePermissionBody,
} from '../dtos/permissions.dto.js';

export async function listPermissions(): Promise<WirePermission[]> {
  const rows = await permissionsRepository.findAll();
  return rows.map(toWirePermission);
}

/**
 * Adds a permission to the catalogue **together with its display names**.
 *
 * The two are one operation, not a create followed by an optional translation
 * step. `seed-core.ts` has always treated them that way; this endpoint did not,
 * and the gap produced permissions that render as "Warehouse Manage" in every
 * language with nothing reporting a fault. The names are written through the
 * same repository `PUT /:code/translations` uses, so there is one write path
 * for `translation_entries`, not two.
 *
 * A brand-new module must bring `module_display` with it — the app labels each
 * permission group from `permission.module.<module>`, and a missing entry is an
 * untranslated header for every user. Refused before the insert, so a rejected
 * request leaves nothing behind.
 */
export async function createPermission(body: CreatePermissionBody): Promise<WirePermission> {
  const existing = await permissionsRepository.findByKey(body.key);
  if (existing) {
    throw new BusinessError(409, `Permission "${body.key}" already exists`, 'permission_key_taken');
  }

  const isNewModule = !(await permissionsRepository.moduleExists(body.module));
  if (isNewModule && body.module_display === undefined) {
    throw new BusinessError(
      422,
      `"${body.module}" is a new module — module_display (ar/en) is required so its permission group has a name`,
      'permission_module_display_required',
    );
  }

  await ensureBundledLanguagesExist();

  const row = await permissionsRepository.insert({
    key: body.key,
    module: body.module,
    is_sensitive: body.is_sensitive,
  });

  // After the insert, deliberately: a failure here leaves a permission whose
  // name falls back to the key — degraded but usable — whereas writing names
  // for a permission that then fails to insert leaves orphan entries that no
  // catalogue read would ever surface or clean up.
  for (const code of ['ar', 'en'] as const) {
    const entries: Record<string, string> = {
      [`permission.${body.key}`]: body.display[code],
    };
    if (body.module_display !== undefined) {
      entries[`permission.module.${body.module}`] = body.module_display[code];
    }
    await translationEntriesRepository.upsertMany(code, entries);
    await languagesRepository.incrementVersion(code);
  }

  return toWirePermission(row);
}

/**
 * `translation_entries` has a foreign key on `languages.code`, and ar/en are
 * seeded rows like any other — a database that skipped `db:seed` would fail the
 * write with a constraint error instead of a readable message.
 */
async function ensureBundledLanguagesExist(): Promise<void> {
  for (const code of ['ar', 'en'] as const) {
    const existing = await languagesRepository.findByCode(code);
    if (!existing) {
      throw new BusinessError(
        500,
        `Language "${code}" is missing — run \`npm run db:seed\` before creating permissions`,

        'language_not_seeded',
      );
    }
  }
}

/** Throws if any of the given keys don't exist in the catalog — used by role creation/update. */
export async function assertPermissionKeysExist(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const found = await permissionsRepository.findByKeys(keys);
  const foundKeys = new Set(found.map((p) => p.key));
  const missing = keys.filter((k) => !foundKeys.has(k));
  if (missing.length > 0) {
    throw new BusinessError(
      422,
      `Unknown permission key(s): ${missing.join(', ')}`,
      'permission_key_unknown',
    );
  }
}

export async function isAnySensitive(keys: string[]): Promise<boolean> {
  if (keys.length === 0) return false;
  const found = await permissionsRepository.findByKeys(keys);
  return found.some((p) => p.is_sensitive);
}
