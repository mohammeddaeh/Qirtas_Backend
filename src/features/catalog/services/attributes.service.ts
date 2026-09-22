import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import * as attributesRepository from '../repositories/attributes.repository.js';
import * as productsRepository from '../repositories/products.repository.js';
import { CATALOG_AUDIT, catalogTarget } from '../audit-actions.js';
import {
  toWireAttributeType,
  toWireAttributeValue,
  type CreateAttributeTypeBody,
  type CreateAttributeValueBody,
  type UpdateAttributeTypeBody,
  type UpdateAttributeValueBody,
  type WireAttributeType,
  type WireAttributeValue,
} from '../dtos/attributes.dto.js';

/**
 * The library with every value — the category and product forms need all of it
 * at once, and it is small. Archived rows are left out: the archive arrives
 * with variants (a value with a past), and until then nothing is archived.
 */
export async function listAttributeTypes(): Promise<WireAttributeType[]> {
  const [types, values] = await Promise.all([
    attributesRepository.findAllTypes(),
    attributesRepository.findAllValues(),
  ]);
  const live = types.filter((t) => t.archived_at === null);
  const counts = await Promise.all(
    live.map((t) => attributesRepository.countCategoriesUsingType(t.id)),
  );
  return live.map((type, i) =>
    toWireAttributeType(
      type,
      values.filter((v) => v.attribute_type_id === type.id && v.archived_at === null),
      counts[i] ?? 0,
    ),
  );
}

async function wireType(id: number): Promise<WireAttributeType> {
  const type = await attributesRepository.findTypeById(id);
  if (!type) throw new NotFoundError('Attribute type not found');
  const [values, count] = await Promise.all([
    attributesRepository.findValuesOfType(id),
    attributesRepository.countCategoriesUsingType(id),
  ]);
  return toWireAttributeType(
    type,
    values.filter((v) => v.archived_at === null),
    count,
  );
}

async function assertTypeNameIsFree(nameAr: string, exceptId?: number): Promise<void> {
  const wanted = normalizeArabic(nameAr);
  const clash = (await attributesRepository.findAllTypes()).find(
    (row) => row.id !== exceptId && normalizeArabic(row.name_ar) === wanted,
  );
  if (clash) {
    throw new BusinessError(
      409,
      `An attribute named "${clash.name_ar}" already exists`,
      'attribute_type_name_taken',
    );
  }
}

async function assertValueIsFree(
  typeId: number,
  valueAr: string,
  exceptId?: number,
): Promise<void> {
  const wanted = normalizeArabic(valueAr);
  const clash = (await attributesRepository.findValuesOfType(typeId)).find(
    (row) => row.id !== exceptId && row.value_normalized === wanted,
  );
  if (clash) {
    throw new BusinessError(
      409,
      `This attribute already has the value "${clash.value_ar}"`,
      'attribute_value_taken',
    );
  }
}

export async function createAttributeType(
  actor: RequestActorContext,
  body: CreateAttributeTypeBody,
): Promise<WireAttributeType> {
  await assertTypeNameIsFree(body.name_ar);
  const row = await attributesRepository.insertType({
    name_ar: body.name_ar,
    name_en: body.name_en ?? null,
    display: body.display,
    ...(body.sort_order !== undefined ? { sort_order: body.sort_order } : {}),
  });
  await recordAudit(
    actor,
    CATALOG_AUDIT.attributeTypeCreate,
    catalogTarget.attributeType(row.id),
    null,
    {
      name_ar: row.name_ar,
      display: row.display,
    },
  );
  return wireType(row.id);
}

export async function updateAttributeType(
  actor: RequestActorContext,
  id: number,
  body: UpdateAttributeTypeBody,
): Promise<WireAttributeType> {
  const existing = await attributesRepository.findTypeById(id);
  if (!existing) throw new NotFoundError('Attribute type not found');
  if (body.name_ar !== undefined) await assertTypeNameIsFree(body.name_ar, id);

  const row = await attributesRepository.updateType(id, body);
  if (!row) throw new NotFoundError('Attribute type not found');
  await recordAudit(
    actor,
    CATALOG_AUDIT.attributeTypeUpdate,
    catalogTarget.attributeType(id),
    { name_ar: existing.name_ar, name_en: existing.name_en, display: existing.display },
    { name_ar: row.name_ar, name_en: row.name_en, display: row.display },
  );
  return wireType(id);
}

/**
 * Deletes an attribute no category allows, with its values. No variant can use
 * such an attribute: removing it from a category is refused while variants
 * below use it (`category_attribute_in_use`), so "no category allows it"
 * already implies "no variant carries it".
 */
export async function deleteAttributeType(actor: RequestActorContext, id: number): Promise<void> {
  const existing = await attributesRepository.findTypeById(id);
  if (!existing) throw new NotFoundError('Attribute type not found');

  const inUse = await attributesRepository.countCategoriesUsingType(id);
  if (inUse > 0) {
    throw new BusinessError(
      409,
      `${inUse} categor${inUse === 1 ? 'y allows' : 'ies allow'} this attribute. Remove it from them first.`,
      'attribute_type_in_use',
      { categories_count: inUse },
    );
  }

  const values = await attributesRepository.findValuesOfType(id);
  await recordAudit(
    actor,
    CATALOG_AUDIT.attributeTypeDelete,
    catalogTarget.attributeType(id),
    {
      name_ar: existing.name_ar,
      values: values.map((v) => v.value_ar),
    },
    null,
  );
  for (const value of values) await attributesRepository.hardDeleteValue(value.id);
  await attributesRepository.hardDeleteType(id);
}

export async function createAttributeValue(
  actor: RequestActorContext,
  typeId: number,
  body: CreateAttributeValueBody,
): Promise<WireAttributeValue> {
  const type = await attributesRepository.findTypeById(typeId);
  if (!type) throw new NotFoundError('Attribute type not found');
  await assertValueIsFree(typeId, body.value_ar);

  const row = await attributesRepository.insertValue({
    attribute_type_id: typeId,
    value_ar: body.value_ar,
    value_en: body.value_en ?? null,
    value_normalized: normalizeArabic(body.value_ar),
    color_hex: body.color_hex ?? null,
    ...(body.sort_order !== undefined ? { sort_order: body.sort_order } : {}),
  });
  await recordAudit(
    actor,
    CATALOG_AUDIT.attributeValueCreate,
    catalogTarget.attributeValue(row.id),
    null,
    {
      attribute_type_id: typeId,
      value_ar: row.value_ar,
    },
  );
  return toWireAttributeValue(row);
}

export async function updateAttributeValue(
  actor: RequestActorContext,
  id: number,
  body: UpdateAttributeValueBody,
): Promise<WireAttributeValue> {
  const existing = await attributesRepository.findValueById(id);
  if (!existing) throw new NotFoundError('Attribute value not found');
  if (body.value_ar !== undefined) {
    await assertValueIsFree(existing.attribute_type_id, body.value_ar, id);
  }

  const row = await attributesRepository.updateValue(id, {
    ...body,
    ...(body.value_ar !== undefined ? { value_normalized: normalizeArabic(body.value_ar) } : {}),
  });
  if (!row) throw new NotFoundError('Attribute value not found');
  await recordAudit(
    actor,
    CATALOG_AUDIT.attributeValueUpdate,
    catalogTarget.attributeValue(id),
    toWireAttributeValue(existing),
    toWireAttributeValue(row),
  );
  return toWireAttributeValue(row);
}

/** Refused while any variant carries the value. */
export async function deleteAttributeValue(actor: RequestActorContext, id: number): Promise<void> {
  const existing = await attributesRepository.findValueById(id);
  if (!existing) throw new NotFoundError('Attribute value not found');
  // A variant IS its combination — deleting «أزرق» would leave a blue pen with no colour.
  const used = await productsRepository.countVariantsUsingValues([id]);
  if (used > 0) {
    throw new BusinessError(409, `${used} variant(s) use this value`, 'attribute_value_in_use', {
      variants_count: used,
    });
  }
  await recordAudit(
    actor,
    CATALOG_AUDIT.attributeValueDelete,
    catalogTarget.attributeValue(id),
    toWireAttributeValue(existing),
    null,
  );
  await attributesRepository.hardDeleteValue(id);
}
