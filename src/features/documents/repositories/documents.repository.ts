import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findOneById } from '../../../core/db/crud-helpers.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import {
  catalogBarcodesTable,
  catalogProductsTable,
  catalogVariantAttributeValuesTable,
  catalogVariantUnitsTable,
  catalogVariantsTable,
} from '../../catalog/schemas/products.schema.js';
import { catalogUnitsTable } from '../../catalog/schemas/units.schema.js';
import { catalogAttributeValuesTable } from '../../catalog/schemas/attributes.schema.js';
import {
  businessProfileTable,
  documentTemplatesTable,
  type BusinessProfileRow,
  type DocumentTemplateRow,
  type NewDocumentTemplateRow,
} from '../schemas/documents.schema.js';
import type { DocumentKind } from '../dtos/layout.schema.js';

const PROFILE_ID = 1;
const t = documentTemplatesTable;

// ── Profile ────────────────────────────────────────────────────────────────

export async function findProfile(): Promise<BusinessProfileRow | undefined> {
  const rows = await db.select().from(businessProfileTable).where(eq(businessProfileTable.id, PROFILE_ID));
  return rows[0];
}

/** Upsert: the row is seeded, but a database seeded before this module still answers. */
export async function saveProfile(
  data: Omit<BusinessProfileRow, 'id' | 'updated_at'>,
): Promise<BusinessProfileRow> {
  const rows = await db
    .insert(businessProfileTable)
    .values({ id: PROFILE_ID, ...data, updated_at: new Date() })
    .onConflictDoUpdate({ target: businessProfileTable.id, set: { ...data, updated_at: new Date() } })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Upsert did not return a row');
  return row;
}

// ── Templates ──────────────────────────────────────────────────────────────

/** Unpaginated: a handful per kind, and the gallery shows all of them. Default first, then ready-made. */
export function findTemplates(kind?: DocumentKind): Promise<DocumentTemplateRow[]> {
  return db
    .select()
    .from(t)
    .where(kind === undefined ? undefined : eq(t.kind, kind))
    .orderBy(asc(t.kind), desc(t.is_default), desc(t.is_system), asc(t.name), asc(t.id));
}

export function findTemplateById(id: number): Promise<DocumentTemplateRow | undefined> {
  return findOneById<DocumentTemplateRow>(t, t.id, id);
}

export async function findDefault(kind: DocumentKind): Promise<DocumentTemplateRow | undefined> {
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.kind, kind), eq(t.is_default, true)));
  return rows[0];
}

export async function insertTemplate(data: NewDocumentTemplateRow): Promise<DocumentTemplateRow> {
  const rows = await db.insert(t).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function updateTemplate(
  id: number,
  data: Partial<NewDocumentTemplateRow>,
): Promise<DocumentTemplateRow | undefined> {
  const rows = await db
    .update(t)
    .set({ ...data, updated_at: new Date() })
    .where(eq(t.id, id))
    .returning();
  return rows[0];
}

/**
 * Moves the default of a kind to this template in one transaction — clear
 * first, then set, so the partial unique index never sees two.
 */
export async function makeDefault(id: number, kind: DocumentKind, userId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(t)
      .set({ is_default: false, updated_at: new Date(), updated_by: userId })
      .where(and(eq(t.kind, kind), eq(t.is_default, true)));
    await tx
      .update(t)
      .set({ is_default: true, updated_at: new Date(), updated_by: userId })
      .where(eq(t.id, id));
  });
}

/**
 * Hard delete — the three conditions of `features/CLAUDE.md` §Delete hold: no
 * row points at a template (a receipt does not record which one printed it),
 * the audit log keeps the story, and a copy made by mistake is disposable by
 * nature. Ready-made and default templates are refused in the service.
 */
export async function hardDeleteTemplate(id: number): Promise<void> {
  await db.delete(t).where(eq(t.id, id));
}

// ── Reads from other modules' tables (allowed; their services are not) ────

export async function findBranch(branchId: number) {
  const rows = await db
    .select({
      id: branchesTable.id,
      name: branchesTable.name,
      address: branchesTable.address,
      contact_info: branchesTable.contact_info,
    })
    .from(branchesTable)
    .where(eq(branchesTable.id, branchId));
  return rows[0];
}

export function findVariants(variantIds: number[]) {
  if (variantIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      id: catalogVariantsTable.id,
      product_id: catalogVariantsTable.product_id,
      sku: catalogVariantsTable.sku,
      base_unit_id: catalogVariantsTable.base_unit_id,
      name_ar: catalogProductsTable.name_ar,
      name_en: catalogProductsTable.name_en,
    })
    .from(catalogVariantsTable)
    .innerJoin(catalogProductsTable, eq(catalogProductsTable.id, catalogVariantsTable.product_id))
    .where(inArray(catalogVariantsTable.id, variantIds));
}

/** «أزرق · A5» — the words that tell one variant from another. */
export async function findVariantLabels(variantIds: number[]): Promise<Map<number, string>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db
    .select({
      variant_id: catalogVariantAttributeValuesTable.variant_id,
      value_ar: catalogAttributeValuesTable.value_ar,
    })
    .from(catalogVariantAttributeValuesTable)
    .innerJoin(
      catalogAttributeValuesTable,
      eq(catalogAttributeValuesTable.id, catalogVariantAttributeValuesTable.attribute_value_id),
    )
    .where(inArray(catalogVariantAttributeValuesTable.variant_id, variantIds))
    .orderBy(asc(catalogVariantAttributeValuesTable.attribute_type_id));
  const parts = new Map<number, string[]>();
  for (const row of rows) parts.set(row.variant_id, [...(parts.get(row.variant_id) ?? []), row.value_ar]);
  return new Map([...parts].map(([variantId, words]) => [variantId, words.join(' · ')]));
}

/** Every unit of these variants, with the codes on each. */
export async function findUnitsWithBarcodes(variantIds: number[]) {
  if (variantIds.length === 0) return [];
  const units = await db
    .select({
      variant_unit_id: catalogVariantUnitsTable.id,
      variant_id: catalogVariantUnitsTable.variant_id,
      unit_id: catalogVariantUnitsTable.unit_id,
      factor: catalogVariantUnitsTable.factor,
      is_base: catalogVariantUnitsTable.is_base,
      name_ar: catalogUnitsTable.name_ar,
    })
    .from(catalogVariantUnitsTable)
    .innerJoin(catalogUnitsTable, eq(catalogUnitsTable.id, catalogVariantUnitsTable.unit_id))
    .where(inArray(catalogVariantUnitsTable.variant_id, variantIds));
  const codes =
    units.length === 0
      ? []
      : await db
          .select({
            variant_unit_id: catalogBarcodesTable.variant_unit_id,
            code: catalogBarcodesTable.code,
            source: catalogBarcodesTable.source,
          })
          .from(catalogBarcodesTable)
          .where(
            inArray(
              catalogBarcodesTable.variant_unit_id,
              units.map((u) => u.variant_unit_id),
            ),
          )
          .orderBy(asc(catalogBarcodesTable.id));
  return units.map((u) => ({ ...u, barcodes: codes.filter((c) => c.variant_unit_id === u.variant_unit_id) }));
}
