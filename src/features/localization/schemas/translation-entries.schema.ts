import { pgTable, serial, varchar, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { languagesTable } from './languages.schema.js';

/**
 * One key→value translation string for a dynamic language. `key` matches a
 * `LocaleKeys.*` key from the Flutter app's static ar/en translation files
 * (see docs/reference/dynamic_localization.md §8). Unique per
 * (language_code, key) — upserted via `PUT /:code/translations`, never
 * duplicated.
 */
export const translationEntriesTable = pgTable(
  'translation_entries',
  {
    id: serial('id').primaryKey(),
    language_code: varchar('language_code', { length: 10 })
      .notNull()
      .references(() => languagesTable.code, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('translation_entries_language_key_unique_idx').on(table.language_code, table.key),
  ],
);

export type TranslationEntryRow = typeof translationEntriesTable.$inferSelect;
export type NewTranslationEntryRow = typeof translationEntriesTable.$inferInsert;
