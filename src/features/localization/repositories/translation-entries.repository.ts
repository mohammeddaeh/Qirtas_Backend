import { eq } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import {
  translationEntriesTable,
  type TranslationEntryRow,
} from '../schemas/translation-entries.schema.js';

export function findByLanguage(languageCode: string): Promise<TranslationEntryRow[]> {
  return db
    .select()
    .from(translationEntriesTable)
    .where(eq(translationEntriesTable.language_code, languageCode));
}

/**
 * Upserts each (language_code, key) pair — existing keys get their `value`
 * replaced, new keys are inserted. Keys not present in `entries` are left
 * untouched (partial-map semantics, see translations.dto.ts). Runs in a
 * transaction so a partial failure never leaves a half-applied batch.
 */
export async function upsertMany(
  languageCode: string,
  entries: Record<string, string>,
): Promise<void> {
  const keys = Object.keys(entries);
  if (keys.length === 0) return;

  await db.transaction(async (tx) => {
    for (const key of keys) {
      await tx
        .insert(translationEntriesTable)
        .values({ language_code: languageCode, key, value: entries[key] as string })
        .onConflictDoUpdate({
          target: [translationEntriesTable.language_code, translationEntriesTable.key],
          set: { value: entries[key] as string, updated_at: new Date() },
        });
    }
  });
}
