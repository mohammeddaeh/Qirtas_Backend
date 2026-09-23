import { BusinessError, NotFoundError, ValidationError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import * as mediaService from '../../../core/media/media.service.js';
import * as categoriesRepository from '../repositories/categories.repository.js';
import * as attributesRepository from '../repositories/attributes.repository.js';
import * as productsRepository from '../repositories/products.repository.js';
import { CATALOG_AUDIT, catalogTarget } from '../audit-actions.js';
import type { CatalogCategoryRow } from '../schemas/categories.schema.js';
import {
  CategoryTree,
  effectiveAttributeTypeIds,
  placementProblem,
  type PlacementProblem,
} from './category-tree.js';
import {
  toWireCategory,
  type CategoriesFilterQuery,
  type CreateCategoryBody,
  type ReplaceCategoryAttributesBody,
  type UpdateCategoryBody,
  type WireCategory,
  type WireCategoryDetail,
  type WirePricingRules,
} from '../dtos/categories.dto.js';

async function loadTree(): Promise<CategoryTree<CatalogCategoryRow>> {
  return new CategoryTree(await categoriesRepository.findAll());
}

function liveChildren(tree: CategoryTree<CatalogCategoryRow>, id: number): CatalogCategoryRow[] {
  return tree.childrenOf(id).filter((child) => child.archived_at === null);
}

function effectiveOf(tree: CategoryTree<CatalogCategoryRow>, id: number) {
  return {
    product_kind: tree.effective(id, 'product_kind'),
    price_policy: tree.effective(id, 'price_policy'),
    pricing_currency: tree.effective(id, 'pricing_currency'),
  };
}

/**
 * The tree as a flat list, parents before children within each level's sort
 * order. Flat rather than nested so the admin screen, pickers and (later) the
 * customer menu each build the shape they need from one response.
 */
export async function listCategories(filter: CategoriesFilterQuery): Promise<WireCategory[]> {
  const rows = await categoriesRepository.findAll();
  const tree = new CategoryTree(rows);
  const wanted = rows.filter((row) =>
    filter.archived ? row.archived_at !== null : row.archived_at === null,
  );
  const images = await mediaService.publicImagesByIds(
    wanted.flatMap((row) => (row.image_id === null ? [] : [row.image_id])),
  );
  return wanted.map((row) =>
    toWireCategory(
      row,
      effectiveOf(tree, row.id),
      row.image_id === null ? null : (images.get(row.image_id) ?? null),
      liveChildren(tree, row.id).length,
    ),
  );
}

export async function getCategory(id: number): Promise<WireCategoryDetail> {
  const [rows, links, types] = await Promise.all([
    categoriesRepository.findAll(),
    categoriesRepository.findAllAttributeLinks(),
    attributesRepository.findAllTypes(),
  ]);
  const tree = new CategoryTree(rows);
  const row = tree.get(id);
  if (!row) throw new NotFoundError('Category not found');

  const ownByCategory = new Map<number, number[]>();
  for (const link of links) {
    ownByCategory.set(link.category_id, [
      ...(ownByCategory.get(link.category_id) ?? []),
      link.attribute_type_id,
    ]);
  }
  const { own, inherited } = effectiveAttributeTypeIds(tree, id, ownByCategory);
  const typeById = new Map(types.map((t) => [t.id, t]));
  const ref = (typeId: number) => {
    const t = typeById.get(typeId)!;
    return { id: t.id, name_ar: t.name_ar, name_en: t.name_en };
  };
  const ownerOf = (typeId: number) =>
    tree.ancestorsOf(id).find((a) => ownByCategory.get(a.id)?.includes(typeId))!.id;

  const image =
    row.image_id === null
      ? null
      : ((await mediaService.publicImagesByIds([row.image_id])).get(row.image_id) ?? null);
  const children = tree.childrenOf(id);
  const activeChildren = liveChildren(tree, id);
  const [productsEver, liveProducts] = await Promise.all([
    productsRepository.countProductsInCategories([id], false),
    productsRepository.countProductsInCategories([id], true),
  ]);

  return {
    ...toWireCategory(row, effectiveOf(tree, id), image, activeChildren.length),
    path: [...tree.ancestorsOf(id)]
      .reverse()
      .map((a) => ({ id: a.id, name_ar: a.name_ar, name_en: a.name_en })),
    attribute_types: {
      own: own.filter((t) => typeById.has(t)).map(ref),
      inherited: inherited
        .filter((t) => typeById.has(t))
        .map((t) => ({ ...ref(t), from_category_id: ownerOf(t) })),
    },
    // Same two exits as branches (rest_api.md §16): delete what nothing ever
    // hung under; archive what has a past but nothing live under it now.
    is_deletable: children.length === 0 && productsEver === 0,
    is_archivable: row.archived_at === null && activeChildren.length === 0 && liveProducts === 0,
    active_children_count: activeChildren.length,
    products_count: productsEver,
    active_products_count: liveProducts,
    pricing_rules: pricingRulesOf(tree, row),
  };
}

/** Own (`null` = inherit) and effective pricing rules — store_system.md §١١. */
function pricingRulesOf(tree: CategoryTree<CatalogCategoryRow>, row: CatalogCategoryRow): WirePricingRules {
  const num = (v: string | null) => (v === null ? null : Number(v));
  return {
    own: {
      price_band_percent: num(row.price_band_percent),
      wholesale_discount_percent: num(row.wholesale_discount_percent),
      wholesale_min_qty: num(row.wholesale_min_qty),
      tax_rate_percent: num(row.tax_rate_percent),
    },
    effective: {
      price_band_percent: tree.effectiveNumber(row.id, 'price_band_percent'),
      wholesale_discount_percent: tree.effectiveNumber(row.id, 'wholesale_discount_percent'),
      wholesale_min_qty: tree.effectiveNumber(row.id, 'wholesale_min_qty'),
      tax_rate_percent: tree.effectiveNumber(row.id, 'tax_rate_percent'),
    },
  };
}

function placementError(problem: PlacementProblem): never {
  switch (problem) {
    case 'parent_not_found':
      throw new ValidationError({ parent_id: ['Parent category not found'] });
    case 'parent_is_self_or_descendant':
      throw new BusinessError(
        422,
        'A category cannot be moved under itself or one of its own subcategories',
        'category_parent_invalid',
      );
    case 'too_deep':
      throw new BusinessError(422, 'Categories go three levels deep at most', 'category_too_deep');
  }
}

/** Sibling names are unique after folding — «دفاتر مدرسية» and «دفاتر مدرسيه» are one category to every reader. */
function assertNameIsFreeAmongSiblings(
  tree: CategoryTree<CatalogCategoryRow>,
  parentId: number | null,
  nameAr: string,
  exceptId?: number,
): void {
  const wanted = normalizeArabic(nameAr);
  const clash = tree
    .childrenOf(parentId)
    .find((row) => row.id !== exceptId && normalizeArabic(row.name_ar) === wanted);
  if (!clash) return;
  if (clash.archived_at !== null) {
    throw new BusinessError(
      409,
      'An archived category here already uses this name — restore it instead, or rename it.',
      'category_name_taken_by_archived',
      { category_id: clash.id },
    );
  }
  throw new BusinessError(
    409,
    `A category named "${clash.name_ar}" already exists here`,
    'category_name_taken',
    { category_id: clash.id },
  );
}

function assertParentIsLive(tree: CategoryTree<CatalogCategoryRow>, parentId: number | null): void {
  if (parentId === null) return;
  if (tree.get(parentId)?.archived_at != null) {
    throw new BusinessError(409, 'The parent category is archived', 'category_parent_archived');
  }
}

/**
 * Products live in leaf categories only. Hanging a subcategory under one that
 * already holds products would leave those products beside the new child,
 * where nobody browsing down the tree finds them.
 */
async function assertParentHoldsNoProducts(parentId: number | null): Promise<void> {
  if (parentId === null) return;
  const count = await productsRepository.countProductsInCategories([parentId], false);
  if (count > 0) {
    throw new BusinessError(
      409,
      'The parent category holds products — move them into a subcategory first',
      'category_parent_has_products',
      { products_count: count },
    );
  }
}

export async function createCategory(
  actor: RequestActorContext,
  body: CreateCategoryBody,
): Promise<WireCategoryDetail> {
  const tree = await loadTree();
  const parentId = body.parent_id ?? null;
  const problem = placementProblem(tree, null, parentId);
  if (problem) placementError(problem);
  assertParentIsLive(tree, parentId);
  await assertParentHoldsNoProducts(parentId);
  assertNameIsFreeAmongSiblings(tree, parentId, body.name_ar);
  if (body.image_id) await mediaService.attachPublicImages('image_id', [body.image_id]);

  const row = await categoriesRepository.insert({
    parent_id: parentId,
    level: tree.levelUnder(parentId),
    name_ar: body.name_ar,
    name_en: body.name_en ?? null,
    product_kind: body.product_kind ?? null,
    price_policy: body.price_policy ?? null,
    pricing_currency: body.pricing_currency ?? null,
    image_id: body.image_id ?? null,
    ...(body.sort_order !== undefined ? { sort_order: body.sort_order } : {}),
    ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
  });
  await recordAudit(
    actor,
    CATALOG_AUDIT.categoryCreate,
    catalogTarget.category(row.id),
    null,
    snapshot(row),
  );
  return getCategory(row.id);
}

function snapshot(row: CatalogCategoryRow) {
  return {
    parent_id: row.parent_id,
    name_ar: row.name_ar,
    name_en: row.name_en,
    product_kind: row.product_kind,
    price_policy: row.price_policy,
    pricing_currency: row.pricing_currency,
    image_id: row.image_id,
    sort_order: row.sort_order,
    is_active: row.is_active,
  };
}

function assertNotArchived(row: CatalogCategoryRow): void {
  if (row.archived_at === null) return;
  throw new BusinessError(
    409,
    'This category is archived. Restore it before editing.',
    'category_archived',
  );
}

export async function updateCategory(
  actor: RequestActorContext,
  id: number,
  body: UpdateCategoryBody,
): Promise<WireCategoryDetail> {
  const tree = await loadTree();
  const existing = tree.get(id);
  if (!existing) throw new NotFoundError('Category not found');
  assertNotArchived(existing);

  const parentId = body.parent_id === undefined ? existing.parent_id : body.parent_id;
  const moving = parentId !== existing.parent_id;
  if (moving) {
    const problem = placementProblem(tree, id, parentId);
    if (problem) placementError(problem);
    assertParentIsLive(tree, parentId);
    await assertParentHoldsNoProducts(parentId);
  }
  if (moving || body.name_ar !== undefined) {
    assertNameIsFreeAmongSiblings(tree, parentId, body.name_ar ?? existing.name_ar, id);
  }
  if (body.image_id) await mediaService.attachPublicImages('image_id', [body.image_id]);

  const changes = { ...body, parent_id: parentId };
  let row: CatalogCategoryRow | undefined;
  if (moving) {
    // The node and every descendant get new levels, in one transaction.
    const levels = new Map<number, number>();
    const base = tree.levelUnder(parentId);
    levels.set(id, base);
    const assign = (nodeId: number, level: number) => {
      for (const child of tree.childrenOf(nodeId)) {
        levels.set(child.id, level + 1);
        assign(child.id, level + 1);
      }
    };
    assign(id, base);
    row = await categoriesRepository.moveWithLevels(id, changes, levels);
  } else {
    row = await categoriesRepository.update(id, changes);
  }
  if (!row) throw new NotFoundError('Category not found');

  await recordAudit(
    actor,
    CATALOG_AUDIT.categoryUpdate,
    catalogTarget.category(id),
    snapshot(existing),
    snapshot(row),
  );
  return getCategory(id);
}

/**
 * Replaces the attributes this category itself allows. Inherited ones are not
 * listed here — they are edited on the ancestor that owns them, which the
 * detail response names (`from_category_id`).
 */
export async function replaceCategoryAttributes(
  actor: RequestActorContext,
  id: number,
  body: ReplaceCategoryAttributesBody,
): Promise<WireCategoryDetail> {
  const existing = await categoriesRepository.findById(id);
  if (!existing) throw new NotFoundError('Category not found');
  assertNotArchived(existing);

  const wanted = [...new Set(body.attribute_type_ids)];
  const types = await attributesRepository.findAllTypes();
  const live = new Set(types.filter((t) => t.archived_at === null).map((t) => t.id));
  const unknown = wanted.filter((typeId) => !live.has(typeId));
  if (unknown.length > 0) {
    throw new ValidationError({
      attribute_type_ids: [`Unknown attribute type(s): ${unknown.join(', ')}`],
    });
  }

  const before = (await categoriesRepository.findAllAttributeLinks())
    .filter((link) => link.category_id === id)
    .map((link) => link.attribute_type_id);

  // Removing an attribute that variants below already use would leave those
  // variants carrying an attribute their category no longer allows.
  const removed = before.filter((typeId) => !wanted.includes(typeId));
  if (removed.length > 0) {
    const tree = await loadTree();
    const inUse = await productsRepository.countVariantsUsingTypesInCategories(removed, [
      id,
      ...tree.descendantIdsOf(id),
    ]);
    if (inUse > 0) {
      throw new BusinessError(
        409,
        'Variants in this category use an attribute being removed',
        'category_attribute_in_use',
        { variants_count: inUse },
      );
    }
  }
  await categoriesRepository.replaceAttributeLinks(id, wanted);
  await recordAudit(
    actor,
    CATALOG_AUDIT.categoryAttributesReplace,
    catalogTarget.category(id),
    { attribute_type_ids: before },
    { attribute_type_ids: wanted },
  );
  return getCategory(id);
}

/**
 * Hard delete — only for a category nothing has ever hung under. Conditions:
 * no child rows at all (archived included, since they still point here via a
 * RESTRICT FK) and — from the products slice on — no product ever. Such a row
 * has no history, no dependants, and a real reason to go: it was made by
 * mistake.
 */
export async function deleteCategory(actor: RequestActorContext, id: number): Promise<void> {
  const tree = await loadTree();
  const existing = tree.get(id);
  if (!existing) throw new NotFoundError('Category not found');

  const children = tree.childrenOf(id).length;
  if (children > 0) {
    throw new BusinessError(
      409,
      `This category has ${children} subcategor${children === 1 ? 'y' : 'ies'}. Move or delete them first, or archive it.`,
      'category_has_children',
      { children_count: children },
    );
  }
  const products = await productsRepository.countProductsInCategories([id], false);
  if (products > 0) {
    throw new BusinessError(
      409,
      `${products} product(s) belong to this category. Move them, or archive the category.`,
      'category_has_products',
      { products_count: products },
    );
  }

  await recordAudit(
    actor,
    CATALOG_AUDIT.categoryDelete,
    catalogTarget.category(id),
    snapshot(existing),
    null,
  );
  await categoriesRepository.hardDelete(id);
}

export async function archiveCategory(
  actor: RequestActorContext,
  id: number,
): Promise<WireCategoryDetail> {
  const tree = await loadTree();
  const existing = tree.get(id);
  if (!existing) throw new NotFoundError('Category not found');
  // Idempotent: two admins reaching the same conclusion is not a conflict.
  if (existing.archived_at !== null) return getCategory(id);

  const active = liveChildren(tree, id).length;
  if (active > 0) {
    throw new BusinessError(
      409,
      `This category still has ${active} live subcategor${active === 1 ? 'y' : 'ies'}. Archive or move them first.`,
      'category_has_active_children',
      { active_children_count: active },
    );
  }
  const liveProducts = await productsRepository.countProductsInCategories([id], true);
  if (liveProducts > 0) {
    throw new BusinessError(
      409,
      `${liveProducts} live product(s) belong to this category. Archive or move them first.`,
      'category_has_active_products',
      { active_products_count: liveProducts },
    );
  }

  const archivedAt = new Date();
  await categoriesRepository.update(id, { archived_at: archivedAt });
  await recordAudit(
    actor,
    CATALOG_AUDIT.categoryArchive,
    catalogTarget.category(id),
    { archived_at: null },
    { archived_at: archivedAt.toISOString() },
  );
  return getCategory(id);
}

export async function unarchiveCategory(
  actor: RequestActorContext,
  id: number,
): Promise<WireCategoryDetail> {
  const tree = await loadTree();
  const existing = tree.get(id);
  if (!existing) throw new NotFoundError('Category not found');
  if (existing.archived_at === null) return getCategory(id);

  // Restoring under an archived parent would produce a live category no list
  // can reach — every walk down the tree stops at the archived parent.
  assertParentIsLive(tree, existing.parent_id);
  assertNameIsFreeAmongSiblings(
    new CategoryTree(tree.childrenOf(existing.parent_id).filter((c) => c.archived_at === null)),
    existing.parent_id,
    existing.name_ar,
    id,
  );

  await categoriesRepository.update(id, { archived_at: null });
  await recordAudit(
    actor,
    CATALOG_AUDIT.categoryUnarchive,
    catalogTarget.category(id),
    { archived_at: existing.archived_at.toISOString() },
    { archived_at: null },
  );
  return getCategory(id);
}
