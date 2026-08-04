import { pgTable, varchar, boolean, integer, timestamp } from 'drizzle-orm/pg-core';

/**
 * A language servable to the Flutter app beyond the two built-in compile-time
 * languages (ar/en — `easy_localization` + `CodegenLoader`, untouched by this
 * table, see docs/reference/dynamic_localization.md §5/§6 "Model 2"). Only
 * languages added later by an admin (e.g. "fr") get a row here — ar/en are
 * intentionally never seeded into this table.
 *
 * `version` is the cache-invalidation signal the app polls for via
 * `GET /languages`: bumped every time any translation_entries row for this
 * language is added/updated (see localization.service.ts).
 */
export const languagesTable = pgTable('languages', {
  code: varchar('code', { length: 10 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  is_rtl: boolean('is_rtl').notNull().default(false),
  version: integer('version').notNull().default(1),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LanguageRow = typeof languagesTable.$inferSelect;
export type NewLanguageRow = typeof languagesTable.$inferInsert;
