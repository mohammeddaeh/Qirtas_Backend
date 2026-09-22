import { asc, count, eq } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findOneById } from '../../../core/db/crud-helpers.js';
import {
  catalogAttributeTypesTable,
  catalogAttributeValuesTable,
  type CatalogAttributeTypeRow,
  type CatalogAttributeValueRow,
  type NewCatalogAttributeTypeRow,
  type NewCatalogAttributeValueRow,
} from '../schemas/attributes.schema.js';
import { catalogCategoryAttributesTable } from '../schemas/categories.schema.js';

/** Unpaginated: the library is small and every category/product form needs it whole. */
export function findAllTypes(): Promise<CatalogAttributeTypeRow[]> {
  return db
    .select()
    .from(catalogAttributeTypesTable)
    .orderBy(asc(catalogAttributeTypesTable.sort_order), asc(catalogAttributeTypesTable.id));
}

export function findAllValues(): Promise<CatalogAttributeValueRow[]> {
  return db
    .select()
    .from(catalogAttributeValuesTable)
    .orderBy(asc(catalogAttributeValuesTable.sort_order), asc(catalogAttributeValuesTable.id));
}

export function findValuesOfType(typeId: number): Promise<CatalogAttributeValueRow[]> {
  return db
    .select()
    .from(catalogAttributeValuesTable)
    .where(eq(catalogAttributeValuesTable.attribute_type_id, typeId))
    .orderBy(asc(catalogAttributeValuesTable.sort_order), asc(catalogAttributeValuesTable.id));
}

export function findTypeById(id: number): Promise<CatalogAttributeTypeRow | undefined> {
  return findOneById<CatalogAttributeTypeRow>(
    catalogAttributeTypesTable,
    catalogAttributeTypesTable.id,
    id,
  );
}

export function findValueById(id: number): Promise<CatalogAttributeValueRow | undefined> {
  return findOneById<CatalogAttributeValueRow>(
    catalogAttributeValuesTable,
    catalogAttributeValuesTable.id,
    id,
  );
}

export async function insertType(
  data: NewCatalogAttributeTypeRow,
): Promise<CatalogAttributeTypeRow> {
  const rows = await db.insert(catalogAttributeTypesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function updateType(
  id: number,
  data: Partial<NewCatalogAttributeTypeRow>,
): Promise<CatalogAttributeTypeRow | undefined> {
  const rows = await db
    .update(catalogAttributeTypesTable)
    .set({ ...data, updated_at: new Date() })
    .where(eq(catalogAttributeTypesTable.id, id))
    .returning();
  return rows[0];
}

export async function insertValue(
  data: NewCatalogAttributeValueRow,
): Promise<CatalogAttributeValueRow> {
  const rows = await db.insert(catalogAttributeValuesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function updateValue(
  id: number,
  data: Partial<NewCatalogAttributeValueRow>,
): Promise<CatalogAttributeValueRow | undefined> {
  const rows = await db
    .update(catalogAttributeValuesTable)
    .set(data)
    .where(eq(catalogAttributeValuesTable.id, id))
    .returning();
  return rows[0];
}

/** How many categories allow this type — a type in use cannot be deleted. */
export async function countCategoriesUsingType(typeId: number): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(catalogCategoryAttributesTable)
    .where(eq(catalogCategoryAttributesTable.attribute_type_id, typeId));
  return rows[0]?.n ?? 0;
}

export async function hardDeleteType(id: number): Promise<void> {
  await db.delete(catalogAttributeTypesTable).where(eq(catalogAttributeTypesTable.id, id));
}

export async function hardDeleteValue(id: number): Promise<void> {
  await db.delete(catalogAttributeValuesTable).where(eq(catalogAttributeValuesTable.id, id));
}
