import { eq, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { languagesTable, type LanguageRow, type NewLanguageRow } from '../schemas/languages.schema.js';

/** No pagination here on purpose — mirrors identity's permissions.repository.ts (small reference catalog, not a paginated resource). */
export function findAllActive(): Promise<LanguageRow[]> {
  return db.select().from(languagesTable).where(eq(languagesTable.is_active, true));
}

export function findByCode(code: string): Promise<LanguageRow | undefined> {
  return db
    .select()
    .from(languagesTable)
    .where(eq(languagesTable.code, code))
    .limit(1)
    .then((rows) => rows[0]);
}

export async function insert(data: NewLanguageRow): Promise<LanguageRow> {
  const rows = await db.insert(languagesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function update(
  code: string,
  data: Partial<NewLanguageRow>,
): Promise<LanguageRow | undefined> {
  const rows = await db
    .update(languagesTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(languagesTable.code, code))
    .returning();
  return rows[0];
}

export async function setActive(code: string, isActive: boolean): Promise<LanguageRow | undefined> {
  return update(code, { is_active: isActive });
}

/** Bumps `version` by 1 — called whenever the language's translation_entries change. */
export async function incrementVersion(code: string): Promise<LanguageRow | undefined> {
  const rows = await db
    .update(languagesTable)
    .set({ version: sql`${languagesTable.version} + 1`, updated_at: new Date() })
    .where(eq(languagesTable.code, code))
    .returning();
  return rows[0];
}
