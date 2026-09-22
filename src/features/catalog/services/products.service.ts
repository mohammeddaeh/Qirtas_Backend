import { BusinessError, NotFoundError, ValidationError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import { db } from '../../../core/db/client.js';
import * as mediaService from '../../../core/media/media.service.js';
import type { WireImage } from '../../../core/media/media.service.js';
import {
  paginated,
  type Paginated,
  type PaginationParams,
} from '../../../core/pagination/pagination.js';
import * as productsRepository from '../repositories/products.repository.js';
import * as categoriesRepository from '../repositories/categories.repository.js';
import * as attributesRepository from '../repositories/attributes.repository.js';
import * as unitsRepository from '../repositories/units.repository.js';
import * as brandsRepository from '../repositories/brands.repository.js';
import { CATALOG_AUDIT, catalogTarget } from '../audit-actions.js';
import { CategoryTree, effectiveAttributeTypeIds } from './category-tree.js';
import {
  variantSetProblem,
  combinationKey,
  type ValueRef,
  type VariantProblem,
} from './variant-rules.js';
import { ambiguityOf, barcodeProblem, internalBarcode, normalizeBarcode } from './barcode-rules.js';
import type { CatalogCategoryRow } from '../schemas/categories.schema.js';
import type { CatalogUnitRow } from '../schemas/units.schema.js';
import type {
  CatalogAttributeTypeRow,
  CatalogAttributeValueRow,
} from '../schemas/attributes.schema.js';
import type { CatalogProductRow, CatalogVariantRow } from '../schemas/products.schema.js';
import type {
  AddBarcodeBody,
  CreateProductBody,
  GenerateBarcodeBody,
  ProductsFilterQuery,
  ReplaceVariantUnitsBody,
  UpdateProductBody,
  UpdateVariantBody,
  VariantInput,
  WireBarcode,
  WireBarcodeLookup,
  WireProductDetail,
  WireProductListItem,
  WireRef,
  WireVariant,
} from '../dtos/products.dto.js';

// ── Context: everything a product rule needs, loaded once per request ───────

interface CatalogContext {
  tree: CategoryTree<CatalogCategoryRow>;
  ownAttributes: Map<number, number[]>;
  types: Map<number, CatalogAttributeTypeRow>;
  values: Map<number, CatalogAttributeValueRow>;
  units: Map<number, CatalogUnitRow>;
}

async function loadContext(): Promise<CatalogContext> {
  const [categories, links, types, values, units] = await Promise.all([
    categoriesRepository.findAll(),
    categoriesRepository.findAllAttributeLinks(),
    attributesRepository.findAllTypes(),
    attributesRepository.findAllValues(),
    unitsRepository.findAll(),
  ]);
  const ownAttributes = new Map<number, number[]>();
  for (const link of links) {
    ownAttributes.set(link.category_id, [
      ...(ownAttributes.get(link.category_id) ?? []),
      link.attribute_type_id,
    ]);
  }
  return {
    tree: new CategoryTree(categories),
    ownAttributes,
    types: new Map(types.map((t) => [t.id, t])),
    values: new Map(values.map((v) => [v.id, v])),
    units: new Map(units.map((u) => [u.id, u])),
  };
}

function allowedTypeIds(ctx: CatalogContext, categoryId: number): Set<number> {
  const { own, inherited } = effectiveAttributeTypeIds(ctx.tree, categoryId, ctx.ownAttributes);
  return new Set([...own, ...inherited].filter((id) => ctx.types.get(id)?.archived_at === null));
}

/**
 * A product lives in a **leaf** category. A product in «أدوات الكتابة» itself,
 * beside «أقلام حبر», is found by nobody who browses down the tree.
 */
function assertUsableCategory(ctx: CatalogContext, categoryId: number): CatalogCategoryRow {
  const category = ctx.tree.get(categoryId);
  if (!category) throw new ValidationError({ category_id: ['Category not found'] });
  if (category.archived_at !== null) {
    throw new BusinessError(409, 'The category is archived', 'product_category_archived');
  }
  if (ctx.tree.childrenOf(categoryId).some((c) => c.archived_at === null)) {
    throw new BusinessError(
      422,
      'Choose the most specific category — this one has subcategories',
      'category_not_leaf',
    );
  }
  return category;
}

// ── Variant input → write ───────────────────────────────────────────────────

function variantProblemError(problem: VariantProblem): never {
  switch (problem.kind) {
    case 'unknown_value':
      throw new ValidationError({
        attribute_value_ids: [`Unknown attribute value ${problem.valueId}`],
      });
    case 'type_not_allowed':
      throw new BusinessError(
        422,
        "This attribute is not allowed in the product's category",
        'variant_attribute_not_allowed',
        { attribute_type_id: problem.typeId },
      );
    case 'type_repeated':
      throw new BusinessError(
        422,
        'A variant takes one value per attribute',
        'variant_attribute_repeated',
        { attribute_type_id: problem.typeId },
      );
    case 'too_many_axes':
      throw new BusinessError(
        422,
        'A product varies on three attributes at most',
        'variant_too_many_axes',
      );
    case 'axes_mismatch':
      throw new BusinessError(
        422,
        "All of a product's variants must use the same attributes",
        'variant_axes_mismatch',
      );
    case 'duplicate_combination':
      throw new BusinessError(
        409,
        'Another variant of this product already has this combination',
        'variant_combination_taken',
      );
  }
}

function valueRefs(ctx: CatalogContext): Map<number, ValueRef> {
  const refs = new Map<number, ValueRef>();
  for (const value of ctx.values.values()) {
    if (value.archived_at === null)
      refs.set(value.id, { id: value.id, typeId: value.attribute_type_id });
  }
  return refs;
}

function assertUnit(ctx: CatalogContext, unitId: number, field: string): CatalogUnitRow {
  const unit = ctx.units.get(unitId);
  if (!unit || !unit.is_active)
    throw new ValidationError({ [field]: [`Unknown or inactive unit ${unitId}`] });
  return unit;
}

function unitWrites(
  ctx: CatalogContext,
  baseUnitId: number,
  input: VariantInput['units'],
): productsRepository.VariantWrite['units'] {
  assertUnit(ctx, baseUnitId, 'base_unit_id');
  const seen = new Set<number>();
  const writes: productsRepository.VariantWrite['units'] = [];
  let base = { online: true, pos: true };
  for (const unit of input) {
    if (seen.has(unit.unit_id))
      throw new ValidationError({ units: [`Unit ${unit.unit_id} listed twice`] });
    seen.add(unit.unit_id);
    assertUnit(ctx, unit.unit_id, 'units');
    if (unit.unit_id === baseUnitId) {
      if (unit.factor !== 1) throw new ValidationError({ units: ['The base unit has factor 1'] });
      base = { online: unit.sellable_online, pos: unit.sellable_at_pos };
      continue;
    }
    // A pack holds more than one base unit; «1 box = 1 piece» is a second name for the same thing.
    if (unit.factor <= 1) {
      throw new BusinessError(
        422,
        'A pack unit must hold more than one base unit',
        'variant_unit_factor_invalid',
      );
    }
    writes.push({
      unitId: unit.unit_id,
      factor: unit.factor,
      isBase: false,
      online: unit.sellable_online,
      pos: unit.sellable_at_pos,
    });
  }
  return [{ unitId: baseUnitId, factor: 1, isBase: true, ...base }, ...writes];
}

function checkedBarcode(raw: string): string {
  const code = normalizeBarcode(raw);
  const problem = barcodeProblem(code);
  if (problem === 'format') {
    throw new BusinessError(
      422,
      'A barcode is 4–32 digits, capital letters or dashes',
      'barcode_format_invalid',
      { code },
    );
  }
  if (problem === 'checksum') {
    throw new BusinessError(
      422,
      'The check digit is wrong — the code was probably mistyped',
      'barcode_checksum_invalid',
      { code },
    );
  }
  return code;
}

function barcodeWrites(
  input: VariantInput['barcodes'],
  units: productsRepository.VariantWrite['units'],
): productsRepository.VariantWrite['barcodes'] {
  const unitIds = new Set(units.map((u) => u.unitId));
  const seen = new Set<string>();
  return input.flatMap((b) => {
    const code = checkedBarcode(b.code);
    if (!unitIds.has(b.unit_id))
      throw new ValidationError({ barcodes: [`Unit ${b.unit_id} is not a unit of this variant`] });
    const key = `${code}:${b.unit_id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ code, unitId: b.unit_id, source: 'manufacturer' as const }];
  });
}

function variantWrite(
  ctx: CatalogContext,
  input: VariantInput,
  index: number,
): productsRepository.VariantWrite {
  const units = unitWrites(ctx, input.base_unit_id, input.units);
  return {
    sku: input.sku?.toUpperCase() ?? null,
    combinationKey: combinationKey(input.attribute_value_ids),
    values: input.attribute_value_ids.map((valueId) => ({
      valueId,
      typeId: ctx.values.get(valueId)!.attribute_type_id,
    })),
    baseUnitId: input.base_unit_id,
    units,
    barcodes: barcodeWrites(input.barcodes, units),
    imageIds: input.image_ids,
    sortOrder: input.sort_order ?? index,
  };
}

/** Postgres unique violation on a named index. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const pg = e.code ? e : e.cause;
  return pg?.code === '23505' && pg.constraint === constraint;
}

async function withUniqueMapping<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error, 'catalog_variants_sku_unique')) {
      throw new BusinessError(
        409,
        'This SKU is already used by another variant',
        'variant_sku_taken',
      );
    }
    if (isUniqueViolation(error, 'catalog_variants_product_combination_unique')) {
      variantProblemError({ kind: 'duplicate_combination' });
    }
    if (isUniqueViolation(error, 'catalog_barcodes_code_unit_unique')) {
      throw new BusinessError(
        409,
        'This unit already carries this barcode',
        'barcode_already_on_unit',
      );
    }
    throw error;
  }
}

function searchText(p: {
  name_ar: string;
  name_en: string | null;
  search_keywords: string[];
}): string {
  return normalizeArabic([p.name_ar, p.name_en ?? '', ...p.search_keywords].join(' '));
}

// ── Reads ───────────────────────────────────────────────────────────────────

function ref(row: { id: number; name_ar: string; name_en: string | null }): WireRef {
  return { id: row.id, name_ar: row.name_ar, name_en: row.name_en };
}

export async function listProducts(
  params: PaginationParams,
  filter: ProductsFilterQuery,
): Promise<Paginated<WireProductListItem>> {
  const categories = await categoriesRepository.findAll();
  const tree = new CategoryTree(categories);
  let categoryIds: number[] | undefined;
  if (filter.category_id !== undefined) {
    categoryIds = [filter.category_id, ...tree.descendantIdsOf(filter.category_id)];
  }
  const code = filter.search ? normalizeBarcode(filter.search) : undefined;
  const { rows, total } = await productsRepository.findMany(params, {
    searchFolded: filter.search ? normalizeArabic(filter.search) : undefined,
    exactCode: code && barcodeProblem(code) === null ? code : undefined,
    categoryIds,
    brandId: filter.brand_id,
    status: filter.status,
    kind: filter.kind,
    archived: filter.archived ?? false,
  });
  return paginated(await listItems(rows, tree), total, params);
}

async function listItems(
  rows: CatalogProductRow[],
  tree: CategoryTree<CatalogCategoryRow>,
): Promise<WireProductListItem[]> {
  const ids = rows.map((r) => r.id);
  const [variants, media, brands] = await Promise.all([
    productsRepository.findVariantsOfProducts(ids),
    productsRepository.findMediaOfProducts(ids),
    Promise.all(
      [...new Set(rows.flatMap((r) => (r.brand_id === null ? [] : [r.brand_id])))].map((id) =>
        brandsRepository.findById(id),
      ),
    ),
  ]);
  const brandById = new Map(brands.flatMap((b) => (b ? [[b.id, b] as const] : [])));
  // The card shows the first product-level image, else the first variant image.
  const firstMedia = new Map<number, number>();
  for (const m of [...media].sort(
    (a, b) => Number(a.variant_id !== null) - Number(b.variant_id !== null),
  )) {
    if (!firstMedia.has(m.product_id)) firstMedia.set(m.product_id, m.media_id);
  }
  const images = await mediaService.publicImagesByIds([...firstMedia.values()]);

  return rows.map((row) => {
    const category = tree.get(row.category_id)!;
    const brand = row.brand_id === null ? undefined : brandById.get(row.brand_id);
    const mediaId = firstMedia.get(row.id);
    return {
      id: row.id,
      name_ar: row.name_ar,
      name_en: row.name_en,
      category: ref(category),
      brand: brand ? { id: brand.id, name: brand.name } : null,
      kind: row.kind,
      status: row.status,
      is_sellable: row.is_sellable,
      thumbnail: mediaId === undefined ? null : (images.get(mediaId) ?? null),
      variants_count: variants.filter((v) => v.product_id === row.id).length,
      archived_at: row.archived_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  });
}

function labelOf(values: WireVariant['values']): { ar: string; en: string | null } {
  return {
    ar: values.map((v) => v.value_ar).join(' · '),
    en: values.length === 0 ? null : values.map((v) => v.value_en ?? v.value_ar).join(' · '),
  };
}

async function wireVariants(
  ctx: CatalogContext,
  product: CatalogProductRow,
  variants: CatalogVariantRow[],
): Promise<{ wire: WireVariant[]; axes: WireRef[] }> {
  const ids = variants.map((v) => v.id);
  const [values, units, media] = await Promise.all([
    productsRepository.findValuesOfVariants(ids),
    productsRepository.findUnitsOfVariants(ids),
    productsRepository.findMediaOfProducts([product.id]),
  ]);
  const barcodes = await productsRepository.findBarcodesOfUnits(units.map((u) => u.id));
  const shared = await productsRepository.countByCodes([...new Set(barcodes.map((b) => b.code))]);
  const images = await mediaService.publicImagesByIds(
    media.filter((m) => m.variant_id !== null).map((m) => m.media_id),
  );

  const axisOrder = [...new Set(values.map((v) => v.attribute_type_id))].sort(
    (a, b) => (ctx.types.get(a)?.sort_order ?? 0) - (ctx.types.get(b)?.sort_order ?? 0),
  );

  const wire = variants.map((variant) => {
    const own = values
      .filter((v) => v.variant_id === variant.id)
      .sort(
        (a, b) => axisOrder.indexOf(a.attribute_type_id) - axisOrder.indexOf(b.attribute_type_id),
      )
      .map((v) => {
        const value = ctx.values.get(v.attribute_value_id)!;
        return {
          attribute_type_id: v.attribute_type_id,
          attribute_value_id: v.attribute_value_id,
          value_ar: value.value_ar,
          value_en: value.value_en,
          color_hex: value.color_hex,
        };
      });
    const ownUnits = units.filter((u) => u.variant_id === variant.id);
    const label = labelOf(own);
    return {
      id: variant.id,
      sku: variant.sku,
      status: variant.status,
      sort_order: variant.sort_order,
      base_unit_id: variant.base_unit_id,
      label_ar: label.ar,
      label_en: label.en,
      values: own,
      units: ownUnits.map((u) => {
        const unit = ctx.units.get(u.unit_id)!;
        return {
          id: u.id,
          unit_id: u.unit_id,
          name_ar: unit.name_ar,
          name_en: unit.name_en,
          factor: Number(u.factor),
          is_base: u.is_base,
          allows_fraction: unit.allows_fraction,
          sellable_online: u.sellable_online,
          sellable_at_pos: u.sellable_at_pos,
        };
      }),
      barcodes: barcodes
        .filter((b) => ownUnits.some((u) => u.id === b.variant_unit_id))
        .map((b): WireBarcode => ({
          id: b.id,
          code: b.code,
          unit_id: ownUnits.find((u) => u.id === b.variant_unit_id)!.unit_id,
          source: b.source,
          is_shared: (shared.get(b.code) ?? 0) > 1,
        })),
      images: media
        .filter((m) => m.variant_id === variant.id)
        .flatMap((m) => {
          const image = images.get(m.media_id);
          return image ? [image] : [];
        }),
    };
  });

  const axes = axisOrder.flatMap((id) => {
    const type = ctx.types.get(id);
    return type ? [ref(type)] : [];
  });
  return { wire, axes };
}

export async function getProduct(id: number): Promise<WireProductDetail> {
  const product = await productsRepository.findById(id);
  if (!product) throw new NotFoundError('Product not found');
  const ctx = await loadContext();
  const variants = await productsRepository.findVariantsOfProducts([id]);
  const [item] = await listItems([product], ctx.tree);
  const { wire, axes } = await wireVariants(ctx, product, variants);
  const media = await productsRepository.findMediaOfProducts([id]);
  const productImages = await mediaService.publicImagesByIds(
    media.filter((m) => m.variant_id === null).map((m) => m.media_id),
  );
  const category = ctx.tree.get(product.category_id)!;

  return {
    ...item!,
    description_ar: product.description_ar,
    description_en: product.description_en,
    search_keywords: product.search_keywords,
    price_policy: product.price_policy,
    pricing_currency: product.pricing_currency,
    effective: {
      price_policy: product.price_policy ?? ctx.tree.effective(category.id, 'price_policy'),
      pricing_currency:
        product.pricing_currency ?? ctx.tree.effective(category.id, 'pricing_currency'),
    },
    category_path: [...ctx.tree.ancestorsOf(category.id)].reverse().concat(category).map(ref),
    allowed_attribute_type_ids: [...allowedTypeIds(ctx, category.id)],
    axes,
    images: media
      .filter((m) => m.variant_id === null)
      .flatMap((m): WireImage[] => {
        const image = productImages.get(m.media_id);
        return image ? [image] : [];
      }),
    variants: wire,
    // Nothing can reference a product yet: stock, prices and orders arrive in
    // phases 2–3, and each adds its count here, by the rule of rest_api.md §16.
    is_deletable: true,
    is_archivable: product.archived_at === null,
  };
}

// ── Product writes ──────────────────────────────────────────────────────────

function assertNotArchived(product: CatalogProductRow): void {
  if (product.archived_at === null) return;
  throw new BusinessError(
    409,
    'This product is archived. Restore it before editing.',
    'product_archived',
  );
}

async function assertBrand(brandId: number | null | undefined): Promise<void> {
  if (brandId === null || brandId === undefined) return;
  const brand = await brandsRepository.findById(brandId);
  if (!brand || brand.archived_at !== null)
    throw new ValidationError({ brand_id: ['Unknown brand'] });
}

function snapshot(p: CatalogProductRow) {
  return {
    category_id: p.category_id,
    brand_id: p.brand_id,
    kind: p.kind,
    is_sellable: p.is_sellable,
    name_ar: p.name_ar,
    name_en: p.name_en,
    price_policy: p.price_policy,
    pricing_currency: p.pricing_currency,
    status: p.status,
  };
}

export async function createProduct(
  actor: RequestActorContext,
  body: CreateProductBody,
): Promise<WireProductDetail> {
  const ctx = await loadContext();
  const category = assertUsableCategory(ctx, body.category_id);
  await assertBrand(body.brand_id);

  const problem = variantSetProblem(
    body.variants.map((v) => v.attribute_value_ids),
    valueRefs(ctx),
    allowedTypeIds(ctx, category.id),
  );
  if (problem) variantProblemError(problem);
  const writes = body.variants.map((v, i) => variantWrite(ctx, v, i));

  const imageIds = [...(body.image_ids ?? []), ...writes.flatMap((w) => w.imageIds)];
  if (imageIds.length > 0) await mediaService.attachPublicImages('image_ids', imageIds);

  const keywords = body.search_keywords ?? [];
  const product = await withUniqueMapping(() =>
    db.transaction(async (tx) => {
      const row = await productsRepository.insertProduct(tx, {
        category_id: category.id,
        brand_id: body.brand_id ?? null,
        kind: body.kind ?? ctx.tree.effective(category.id, 'product_kind') ?? 'retail',
        is_sellable: body.is_sellable ?? true,
        name_ar: body.name_ar,
        name_en: body.name_en ?? null,
        description_ar: body.description_ar ?? null,
        description_en: body.description_en ?? null,
        search_keywords: keywords,
        search_text: searchText({
          name_ar: body.name_ar,
          name_en: body.name_en ?? null,
          search_keywords: keywords,
        }),
        price_policy: body.price_policy ?? null,
        pricing_currency: body.pricing_currency ?? null,
        status: body.status,
        created_by_user_id: actor.userId,
      });
      await productsRepository.replaceProductImages(tx, row.id, body.image_ids ?? []);
      for (const write of writes) await productsRepository.insertVariant(tx, row.id, write);
      return row;
    }),
  );

  await recordAudit(actor, CATALOG_AUDIT.productCreate, catalogTarget.product(product.id), null, {
    ...snapshot(product),
    variants: body.variants.length,
  });
  return getProduct(product.id);
}

export async function updateProduct(
  actor: RequestActorContext,
  id: number,
  body: UpdateProductBody,
): Promise<WireProductDetail> {
  const existing = await productsRepository.findById(id);
  if (!existing) throw new NotFoundError('Product not found');
  assertNotArchived(existing);
  const ctx = await loadContext();

  if (body.category_id !== undefined && body.category_id !== existing.category_id) {
    const category = assertUsableCategory(ctx, body.category_id);
    // The variants must stay legal in the new category, or the product would
    // carry attributes its own category forbids.
    const variants = await productsRepository.findVariantsOfProducts([id]);
    const values = await productsRepository.findValuesOfVariants(variants.map((v) => v.id));
    const allowed = allowedTypeIds(ctx, category.id);
    if (values.some((v) => !allowed.has(v.attribute_type_id))) {
      throw new BusinessError(
        409,
        "This product's variants use attributes the new category does not allow",
        'product_attributes_not_allowed_in_category',
      );
    }
  }
  if (body.brand_id !== undefined) await assertBrand(body.brand_id);
  if (body.status === 'active' || (body.status === undefined && existing.status === 'active')) {
    const variants = await productsRepository.findVariantsOfProducts([id]);
    if (!variants.some((v) => v.status === 'active')) {
      throw new BusinessError(
        422,
        'A product on sale needs at least one active variant',
        'product_needs_active_variant',
      );
    }
  }
  if (body.image_ids?.length) await mediaService.attachPublicImages('image_ids', body.image_ids);

  const { image_ids: imageIds, ...fields } = body;
  const next = {
    name_ar: fields.name_ar ?? existing.name_ar,
    name_en: fields.name_en === undefined ? existing.name_en : fields.name_en,
    search_keywords: fields.search_keywords ?? existing.search_keywords,
  };
  const row = await db.transaction(async (tx) => {
    const updated = await productsRepository.updateProduct(tx, id, {
      ...fields,
      search_text: searchText(next),
    });
    if (imageIds !== undefined) await productsRepository.replaceProductImages(tx, id, imageIds);
    return updated;
  });
  if (!row) throw new NotFoundError('Product not found');

  await recordAudit(
    actor,
    CATALOG_AUDIT.productUpdate,
    catalogTarget.product(id),
    snapshot(existing),
    snapshot(row),
  );
  return getProduct(id);
}

/**
 * Hard delete. The three conditions hold today — nothing (stock, price, order)
 * can reference a product yet, so a product has no history beyond its own
 * audit entries. Phases 2–3 add those counts here and route a product with a
 * past to [archiveProduct] instead.
 */
export async function deleteProduct(actor: RequestActorContext, id: number): Promise<void> {
  const existing = await productsRepository.findById(id);
  if (!existing) throw new NotFoundError('Product not found');
  await recordAudit(
    actor,
    CATALOG_AUDIT.productDelete,
    catalogTarget.product(id),
    snapshot(existing),
    null,
  );
  await db.transaction((tx) => productsRepository.hardDeleteProduct(tx, id));
}

export async function archiveProduct(
  actor: RequestActorContext,
  id: number,
): Promise<WireProductDetail> {
  const existing = await productsRepository.findById(id);
  if (!existing) throw new NotFoundError('Product not found');
  if (existing.archived_at !== null) return getProduct(id);
  const at = new Date();
  await productsRepository.updateProduct(db, id, { archived_at: at });
  await recordAudit(
    actor,
    CATALOG_AUDIT.productArchive,
    catalogTarget.product(id),
    { archived_at: null },
    {
      archived_at: at.toISOString(),
    },
  );
  return getProduct(id);
}

export async function unarchiveProduct(
  actor: RequestActorContext,
  id: number,
): Promise<WireProductDetail> {
  const existing = await productsRepository.findById(id);
  if (!existing) throw new NotFoundError('Product not found');
  if (existing.archived_at === null) return getProduct(id);
  const ctx = await loadContext();
  // Restoring into an archived category makes a live product nobody can browse to.
  if (ctx.tree.get(existing.category_id)?.archived_at != null) {
    throw new BusinessError(409, 'The category is archived', 'product_category_archived');
  }
  await productsRepository.updateProduct(db, id, { archived_at: null });
  await recordAudit(
    actor,
    CATALOG_AUDIT.productUnarchive,
    catalogTarget.product(id),
    { archived_at: existing.archived_at.toISOString() },
    { archived_at: null },
  );
  return getProduct(id);
}

// ── Variant writes ──────────────────────────────────────────────────────────

async function productOfVariant(
  variantId: number,
): Promise<{ variant: CatalogVariantRow; product: CatalogProductRow }> {
  const variant = await productsRepository.findVariantById(variantId);
  if (!variant) throw new NotFoundError('Variant not found');
  const product = (await productsRepository.findById(variant.product_id))!;
  assertNotArchived(product);
  return { variant, product };
}

async function valueIdsOfOtherVariants(
  productId: number,
  exceptVariantId: number | null,
): Promise<number[][]> {
  const variants = (await productsRepository.findVariantsOfProducts([productId])).filter(
    (v) => v.id !== exceptVariantId,
  );
  const values = await productsRepository.findValuesOfVariants(variants.map((v) => v.id));
  return variants.map((v) =>
    values.filter((x) => x.variant_id === v.id).map((x) => x.attribute_value_id),
  );
}

export async function addVariant(
  actor: RequestActorContext,
  productId: number,
  input: VariantInput,
): Promise<WireProductDetail> {
  const product = await productsRepository.findById(productId);
  if (!product) throw new NotFoundError('Product not found');
  assertNotArchived(product);
  const ctx = await loadContext();

  const problem = variantSetProblem(
    [...(await valueIdsOfOtherVariants(productId, null)), input.attribute_value_ids],
    valueRefs(ctx),
    allowedTypeIds(ctx, product.category_id),
  );
  if (problem) variantProblemError(problem);
  const existingCount = (await productsRepository.findVariantsOfProducts([productId])).length;
  const write = variantWrite(ctx, input, existingCount);
  if (write.imageIds.length > 0) await mediaService.attachPublicImages('image_ids', write.imageIds);

  const variant = await withUniqueMapping(() =>
    db.transaction((tx) => productsRepository.insertVariant(tx, productId, write)),
  );
  await recordAudit(actor, CATALOG_AUDIT.variantCreate, catalogTarget.variant(variant.id), null, {
    product_id: productId,
    sku: variant.sku,
    attribute_value_ids: input.attribute_value_ids,
  });
  return getProduct(productId);
}

export async function updateVariant(
  actor: RequestActorContext,
  variantId: number,
  body: UpdateVariantBody,
): Promise<WireProductDetail> {
  const { variant, product } = await productOfVariant(variantId);
  const ctx = await loadContext();

  if (body.attribute_value_ids !== undefined) {
    const problem = variantSetProblem(
      [...(await valueIdsOfOtherVariants(product.id, variantId)), body.attribute_value_ids],
      valueRefs(ctx),
      allowedTypeIds(ctx, product.category_id),
    );
    if (problem) variantProblemError(problem);
  }
  if (body.status === 'discontinued' && product.status === 'active') {
    const others = (await productsRepository.findVariantsOfProducts([product.id])).filter(
      (v) => v.id !== variantId && v.status === 'active',
    );
    if (others.length === 0) {
      throw new BusinessError(
        422,
        'A product on sale needs at least one active variant',
        'product_needs_active_variant',
      );
    }
  }
  if (body.image_ids?.length) await mediaService.attachPublicImages('image_ids', body.image_ids);

  const before = await productsRepository.findValuesOfVariants([variantId]);
  await withUniqueMapping(() =>
    db.transaction(async (tx) => {
      await productsRepository.updateVariant(tx, variantId, {
        ...(body.sku !== undefined ? { sku: body.sku.toUpperCase() } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.sort_order !== undefined ? { sort_order: body.sort_order } : {}),
        ...(body.attribute_value_ids !== undefined
          ? { combination_key: combinationKey(body.attribute_value_ids) }
          : {}),
      });
      if (body.attribute_value_ids !== undefined) {
        await productsRepository.replaceVariantValues(
          tx,
          variantId,
          body.attribute_value_ids.map((valueId) => ({
            valueId,
            typeId: ctx.values.get(valueId)!.attribute_type_id,
          })),
        );
      }
      if (body.image_ids !== undefined) {
        await productsRepository.replaceVariantImages(tx, product.id, variantId, body.image_ids);
      }
    }),
  );

  await recordAudit(
    actor,
    CATALOG_AUDIT.variantUpdate,
    catalogTarget.variant(variantId),
    {
      sku: variant.sku,
      status: variant.status,
      attribute_value_ids: before.map((v) => v.attribute_value_id),
    },
    {
      sku: body.sku?.toUpperCase() ?? variant.sku,
      status: body.status ?? variant.status,
      attribute_value_ids: body.attribute_value_ids ?? before.map((v) => v.attribute_value_id),
    },
  );
  return getProduct(product.id);
}

/** Hard delete — no stock can reference a variant yet (phase 3 adds that count). A product keeps at least one. */
export async function deleteVariant(
  actor: RequestActorContext,
  variantId: number,
): Promise<WireProductDetail> {
  const { variant, product } = await productOfVariant(variantId);
  const siblings = await productsRepository.findVariantsOfProducts([product.id]);
  if (siblings.length <= 1) {
    throw new BusinessError(
      409,
      'A product needs at least one variant — delete the product instead',
      'product_needs_variant',
    );
  }
  await recordAudit(
    actor,
    CATALOG_AUDIT.variantDelete,
    catalogTarget.variant(variantId),
    { sku: variant.sku },
    null,
  );
  await db.transaction((tx) => productsRepository.hardDeleteVariant(tx, variantId));
  return getProduct(product.id);
}

export async function replaceVariantUnits(
  actor: RequestActorContext,
  variantId: number,
  body: ReplaceVariantUnitsBody,
): Promise<WireProductDetail> {
  const { variant, product } = await productOfVariant(variantId);
  const ctx = await loadContext();
  const writes = unitWrites(ctx, variant.base_unit_id, body.units);

  const current = await productsRepository.findUnitsOfVariants([variantId]);
  const kept = new Set(writes.map((w) => w.unitId));
  const dropped = current.filter((u) => !kept.has(u.unit_id));
  const barcodes = await productsRepository.findBarcodesOfUnits(dropped.map((u) => u.id));
  if (barcodes.length > 0) {
    throw new BusinessError(
      409,
      'Remove the barcodes printed on this unit before removing the unit',
      'variant_unit_has_barcodes',
      { codes: barcodes.map((b) => b.code) },
    );
  }

  await db.transaction((tx) => productsRepository.replaceVariantUnits(tx, variantId, writes));
  await recordAudit(
    actor,
    CATALOG_AUDIT.variantUnitsReplace,
    catalogTarget.variant(variantId),
    current.map((u) => ({ unit_id: u.unit_id, factor: Number(u.factor) })),
    writes.map((w) => ({ unit_id: w.unitId, factor: w.factor })),
  );
  return getProduct(product.id);
}

// ── Barcodes ────────────────────────────────────────────────────────────────

async function unitRowOf(variantId: number, unitId: number) {
  const units = await productsRepository.findUnitsOfVariants([variantId]);
  const row = units.find((u) => u.unit_id === unitId);
  if (!row)
    throw new ValidationError({ unit_id: [`Unit ${unitId} is not a unit of this variant`] });
  return row;
}

export async function addBarcode(
  actor: RequestActorContext,
  variantId: number,
  body: AddBarcodeBody,
): Promise<WireProductDetail> {
  const { product } = await productOfVariant(variantId);
  const code = checkedBarcode(body.code);
  await unitRowOf(variantId, body.unit_id);

  const [row] = await withUniqueMapping(() =>
    productsRepository.insertBarcodes(db, variantId, [
      { code, unitId: body.unit_id, source: 'manufacturer' },
    ]),
  );
  await recordAudit(actor, CATALOG_AUDIT.barcodeAdd, catalogTarget.variant(variantId), null, {
    barcode_id: row!.id,
    code,
    unit_id: body.unit_id,
  });
  return getProduct(product.id);
}

/**
 * The permanent fix for a shared factory code: a code of our own, from the
 * in-store range, printed on a label and stuck over the factory's.
 */
export async function generateInternalBarcode(
  actor: RequestActorContext,
  variantId: number,
  body: GenerateBarcodeBody,
): Promise<WireProductDetail> {
  const { product } = await productOfVariant(variantId);
  await unitRowOf(variantId, body.unit_id);

  const row = await db.transaction(async (tx) => {
    const code = internalBarcode(await productsRepository.nextInternalBarcodeNumber(tx));
    const [inserted] = await productsRepository.insertBarcodes(tx, variantId, [
      { code, unitId: body.unit_id, source: 'internal' },
    ]);
    return inserted!;
  });
  await recordAudit(actor, CATALOG_AUDIT.barcodeGenerate, catalogTarget.variant(variantId), null, {
    barcode_id: row.id,
    code: row.code,
    unit_id: body.unit_id,
  });
  return getProduct(product.id);
}

export async function deleteBarcode(
  actor: RequestActorContext,
  barcodeId: number,
): Promise<WireProductDetail> {
  const barcode = await productsRepository.findBarcodeById(barcodeId);
  if (!barcode) throw new NotFoundError('Barcode not found');
  const unit = (await productsRepository.findVariantUnitById(barcode.variant_unit_id))!;
  const { product } = await productOfVariant(unit.variant_id);

  await recordAudit(
    actor,
    CATALOG_AUDIT.barcodeRemove,
    catalogTarget.variant(unit.variant_id),
    {
      barcode_id: barcode.id,
      code: barcode.code,
      unit_id: unit.unit_id,
    },
    null,
  );
  await productsRepository.deleteBarcode(barcodeId);
  return getProduct(product.id);
}

/**
 * What a scan means. Archived products are left out: a code on a retired item
 * is not a match to offer at the counter.
 */
export async function lookupBarcode(rawCode: string): Promise<WireBarcodeLookup> {
  const code = normalizeBarcode(rawCode);
  const barcodes = await productsRepository.findBarcodesByCode(code);
  const ctx = await loadContext();

  const matches: WireBarcodeLookup['matches'] = [];
  for (const barcode of barcodes) {
    const unit = (await productsRepository.findVariantUnitById(barcode.variant_unit_id))!;
    const variant = (await productsRepository.findVariantById(unit.variant_id))!;
    const product = (await productsRepository.findById(variant.product_id))!;
    if (product.archived_at !== null) continue;
    const values = await productsRepository.findValuesOfVariants([variant.id]);
    const [item] = await listItems([product], ctx.tree);
    matches.push({
      barcode_id: barcode.id,
      product_id: product.id,
      product_name_ar: product.name_ar,
      product_name_en: product.name_en,
      product_status: product.status,
      variant_id: variant.id,
      sku: variant.sku,
      variant_label_ar: values
        .map((v) => ctx.values.get(v.attribute_value_id)?.value_ar ?? '')
        .join(' · '),
      variant_status: variant.status,
      unit_id: unit.unit_id,
      unit_name_ar: ctx.units.get(unit.unit_id)?.name_ar ?? '',
      factor: Number(unit.factor),
      thumbnail: item?.thumbnail ?? null,
    });
  }
  return {
    code,
    ambiguity: ambiguityOf(matches.map((m) => ({ variantId: m.variant_id, unitId: m.unit_id }))),
    matches,
  };
}

/** The dashboard signal: codes printed on more than one (variant, unit), worst first. */
export async function listSharedBarcodes(): Promise<
  { code: string; matches_count: number; ambiguity: 'unit' | 'item' }[]
> {
  const shared = await productsRepository.findSharedCodes(200);
  const result = [];
  for (const { code, n } of shared) {
    const lookup = await lookupBarcode(code);
    result.push({
      code,
      matches_count: n,
      ambiguity: lookup.ambiguity === 'item' ? ('item' as const) : ('unit' as const),
    });
  }
  return result;
}

/** List items for [ids] in the given order — for collections, which curate their own order. */
export async function listItemsByIds(ids: number[]): Promise<WireProductListItem[]> {
  const rows = await productsRepository.findManyByIds(ids);
  const tree = new CategoryTree(await categoriesRepository.findAll());
  const items = await listItems(rows, tree);
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}
