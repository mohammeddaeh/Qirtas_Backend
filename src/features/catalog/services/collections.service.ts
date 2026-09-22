import { NotFoundError, ValidationError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import * as mediaService from '../../../core/media/media.service.js';
import * as collectionsRepository from '../repositories/collections.repository.js';
import * as productsRepository from '../repositories/products.repository.js';
import * as productsService from './products.service.js';
import { CATALOG_AUDIT, catalogTarget } from '../audit-actions.js';
import type { CatalogCollectionRow } from '../schemas/collections.schema.js';
import {
  toWireCollection,
  type CreateCollectionBody,
  type ReplaceCollectionProductsBody,
  type UpdateCollectionBody,
  type WireCollection,
  type WireCollectionDetail,
} from '../dtos/collections.dto.js';

async function wire(rows: CatalogCollectionRow[]): Promise<WireCollection[]> {
  const [images, counts] = await Promise.all([
    mediaService.publicImagesByIds(rows.flatMap((r) => (r.image_id === null ? [] : [r.image_id]))),
    collectionsRepository.productCounts(rows.map((r) => r.id)),
  ]);
  return rows.map((row) =>
    toWireCollection(
      row,
      row.image_id === null ? null : (images.get(row.image_id) ?? null),
      counts.get(row.id) ?? 0,
    ),
  );
}

export async function listCollections(): Promise<WireCollection[]> {
  return wire(await collectionsRepository.findAll());
}

export async function getCollection(id: number): Promise<WireCollectionDetail> {
  const row = await collectionsRepository.findById(id);
  if (!row) throw new NotFoundError('Collection not found');
  const [collection] = await wire([row]);
  const products = await productsService.listItemsByIds(
    await collectionsRepository.productIdsOf(id),
  );
  return { ...collection!, products };
}

function toDates(body: { starts_at?: string | null; ends_at?: string | null }) {
  return {
    ...(body.starts_at !== undefined
      ? { starts_at: body.starts_at === null ? null : new Date(body.starts_at) }
      : {}),
    ...(body.ends_at !== undefined
      ? { ends_at: body.ends_at === null ? null : new Date(body.ends_at) }
      : {}),
  };
}

export async function createCollection(
  actor: RequestActorContext,
  body: CreateCollectionBody,
): Promise<WireCollectionDetail> {
  if (body.image_id) await mediaService.attachPublicImages('image_id', [body.image_id]);
  const row = await collectionsRepository.insert({
    name_ar: body.name_ar,
    name_en: body.name_en ?? null,
    image_id: body.image_id ?? null,
    ...toDates(body),
    ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
    ...(body.sort_order !== undefined ? { sort_order: body.sort_order } : {}),
  });
  await recordAudit(actor, CATALOG_AUDIT.collectionCreate, catalogTarget.collection(row.id), null, {
    name_ar: row.name_ar,
  });
  return getCollection(row.id);
}

export async function updateCollection(
  actor: RequestActorContext,
  id: number,
  body: UpdateCollectionBody,
): Promise<WireCollectionDetail> {
  const existing = await collectionsRepository.findById(id);
  if (!existing) throw new NotFoundError('Collection not found');
  if (body.image_id) await mediaService.attachPublicImages('image_id', [body.image_id]);
  const row = await collectionsRepository.update(id, {
    ...(body.name_ar !== undefined ? { name_ar: body.name_ar } : {}),
    ...(body.name_en !== undefined ? { name_en: body.name_en } : {}),
    ...(body.image_id !== undefined ? { image_id: body.image_id } : {}),
    ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
    ...(body.sort_order !== undefined ? { sort_order: body.sort_order } : {}),
    ...toDates(body),
  });
  if (!row) throw new NotFoundError('Collection not found');
  await recordAudit(
    actor,
    CATALOG_AUDIT.collectionUpdate,
    catalogTarget.collection(id),
    { name_ar: existing.name_ar, is_active: existing.is_active },
    { name_ar: row.name_ar, is_active: row.is_active },
  );
  return getCollection(id);
}

/** Replaces the collection's products, in the order given — the order is what customers see. */
export async function replaceCollectionProducts(
  actor: RequestActorContext,
  id: number,
  body: ReplaceCollectionProductsBody,
): Promise<WireCollectionDetail> {
  const existing = await collectionsRepository.findById(id);
  if (!existing) throw new NotFoundError('Collection not found');
  const ids = [...new Set(body.product_ids)];
  const found = await productsRepository.findManyByIds(ids);
  const live = new Set(found.filter((p) => p.archived_at === null).map((p) => p.id));
  const unknown = ids.filter((pid) => !live.has(pid));
  if (unknown.length > 0)
    throw new ValidationError({
      product_ids: [`Unknown or archived product(s): ${unknown.join(', ')}`],
    });

  const before = await collectionsRepository.productIdsOf(id);
  await collectionsRepository.replaceProducts(id, ids);
  await recordAudit(
    actor,
    CATALOG_AUDIT.collectionProductsReplace,
    catalogTarget.collection(id),
    { product_ids: before },
    { product_ids: ids },
  );
  return getCollection(id);
}

/**
 * Hard delete: a collection is a curated list with no history of its own —
 * removing it removes a shelf label, never a product or a sale.
 */
export async function deleteCollection(actor: RequestActorContext, id: number): Promise<void> {
  const existing = await collectionsRepository.findById(id);
  if (!existing) throw new NotFoundError('Collection not found');
  await recordAudit(
    actor,
    CATALOG_AUDIT.collectionDelete,
    catalogTarget.collection(id),
    { name_ar: existing.name_ar },
    null,
  );
  await collectionsRepository.hardDelete(id);
}
