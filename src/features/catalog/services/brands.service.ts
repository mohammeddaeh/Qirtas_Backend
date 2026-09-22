import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import * as mediaService from '../../../core/media/media.service.js';
import {
  paginated,
  type Paginated,
  type PaginationParams,
} from '../../../core/pagination/pagination.js';
import * as brandsRepository from '../repositories/brands.repository.js';
import * as productsRepository from '../repositories/products.repository.js';
import { CATALOG_AUDIT, catalogTarget } from '../audit-actions.js';
import type { CatalogBrandRow } from '../schemas/brands.schema.js';
import {
  toWireBrand,
  type BrandsFilterQuery,
  type CreateBrandBody,
  type UpdateBrandBody,
  type WireBrand,
} from '../dtos/brands.dto.js';

async function wire(rows: CatalogBrandRow[]): Promise<WireBrand[]> {
  const logos = await mediaService.publicImagesByIds(
    rows.flatMap((row) => (row.logo_image_id === null ? [] : [row.logo_image_id])),
  );
  return rows.map((row) =>
    toWireBrand(row, row.logo_image_id === null ? null : (logos.get(row.logo_image_id) ?? null)),
  );
}

async function wireOne(row: CatalogBrandRow): Promise<WireBrand> {
  return (await wire([row]))[0]!;
}

export async function listBrands(
  params: PaginationParams,
  filter: BrandsFilterQuery,
): Promise<Paginated<WireBrand>> {
  const { rows, total } = await brandsRepository.findMany(params, filter);
  return paginated(await wire(rows), total, params);
}

async function assertNameIsFree(normalized: string, exceptId?: number): Promise<void> {
  const clash = await brandsRepository.findByNormalizedName(normalized);
  if (!clash || clash.id === exceptId) return;
  throw new BusinessError(409, `A brand named "${clash.name}" already exists`, 'brand_name_taken');
}

export async function createBrand(
  actor: RequestActorContext,
  body: CreateBrandBody,
): Promise<WireBrand> {
  const normalized = normalizeArabic(body.name);
  await assertNameIsFree(normalized);
  if (body.logo_image_id)
    await mediaService.attachPublicImages('logo_image_id', [body.logo_image_id]);

  const row = await brandsRepository.insert({
    name: body.name,
    name_normalized: normalized,
    logo_image_id: body.logo_image_id ?? null,
  });
  await recordAudit(actor, CATALOG_AUDIT.brandCreate, catalogTarget.brand(row.id), null, {
    name: row.name,
    logo_image_id: row.logo_image_id,
  });
  return wireOne(row);
}

export async function updateBrand(
  actor: RequestActorContext,
  id: number,
  body: UpdateBrandBody,
): Promise<WireBrand> {
  const existing = await brandsRepository.findById(id);
  if (!existing) throw new NotFoundError('Brand not found');

  const normalized = body.name === undefined ? undefined : normalizeArabic(body.name);
  if (normalized !== undefined) await assertNameIsFree(normalized, id);
  if (body.logo_image_id)
    await mediaService.attachPublicImages('logo_image_id', [body.logo_image_id]);

  const row = await brandsRepository.update(id, {
    ...body,
    ...(normalized !== undefined ? { name_normalized: normalized } : {}),
  });
  if (!row) throw new NotFoundError('Brand not found');
  await recordAudit(
    actor,
    CATALOG_AUDIT.brandUpdate,
    catalogTarget.brand(id),
    { name: existing.name, logo_image_id: existing.logo_image_id },
    { name: row.name, logo_image_id: row.logo_image_id },
  );
  return wireOne(row);
}

/**
 * Hard delete for a brand no product ever carried; a brand with products is
 * archived instead — the same two exits as branches (rest_api.md §16).
 */
export async function deleteBrand(actor: RequestActorContext, id: number): Promise<void> {
  const existing = await brandsRepository.findById(id);
  if (!existing) throw new NotFoundError('Brand not found');
  const products = await productsRepository.countProductsOfBrand(id);
  if (products > 0) {
    throw new BusinessError(
      409,
      `${products} product(s) carry this brand — archive it instead`,
      'brand_in_use',
      { products_count: products },
    );
  }
  await recordAudit(
    actor,
    CATALOG_AUDIT.brandDelete,
    catalogTarget.brand(id),
    { name: existing.name },
    null,
  );
  await brandsRepository.hardDelete(id);
}

/**
 * Hides a brand from pickers while the products that carry it keep showing it
 * — a discontinued brand is still the brand of what is already on the shelf.
 */
export async function archiveBrand(actor: RequestActorContext, id: number): Promise<WireBrand> {
  const existing = await brandsRepository.findById(id);
  if (!existing) throw new NotFoundError('Brand not found');
  if (existing.archived_at !== null) return wireOne(existing);
  const at = new Date();
  const row = (await brandsRepository.update(id, { archived_at: at }))!;
  await recordAudit(
    actor,
    CATALOG_AUDIT.brandArchive,
    catalogTarget.brand(id),
    { archived_at: null },
    {
      archived_at: at.toISOString(),
    },
  );
  return wireOne(row);
}

export async function unarchiveBrand(actor: RequestActorContext, id: number): Promise<WireBrand> {
  const existing = await brandsRepository.findById(id);
  if (!existing) throw new NotFoundError('Brand not found');
  if (existing.archived_at === null) return wireOne(existing);
  const row = (await brandsRepository.update(id, { archived_at: null }))!;
  await recordAudit(
    actor,
    CATALOG_AUDIT.brandUnarchive,
    catalogTarget.brand(id),
    { archived_at: existing.archived_at.toISOString() },
    { archived_at: null },
  );
  return wireOne(row);
}
