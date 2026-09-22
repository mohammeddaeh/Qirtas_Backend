import { asc, eq } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findOneById } from '../../../core/db/crud-helpers.js';
import {
  catalogUnitsTable,
  type CatalogUnitRow,
  type NewCatalogUnitRow,
} from '../schemas/units.schema.js';

/** Unpaginated: a handful of rows, and every product form needs all of them. */
export function findAll(): Promise<CatalogUnitRow[]> {
  return db
    .select()
    .from(catalogUnitsTable)
    .orderBy(asc(catalogUnitsTable.sort_order), asc(catalogUnitsTable.id));
}

export function findById(id: number): Promise<CatalogUnitRow | undefined> {
  return findOneById<CatalogUnitRow>(catalogUnitsTable, catalogUnitsTable.id, id);
}

export async function insert(data: NewCatalogUnitRow): Promise<CatalogUnitRow> {
  const rows = await db.insert(catalogUnitsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function update(
  id: number,
  data: Partial<NewCatalogUnitRow>,
): Promise<CatalogUnitRow | undefined> {
  const rows = await db
    .update(catalogUnitsTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(catalogUnitsTable.id, id))
    .returning();
  return rows[0];
}
