import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import { paginated, type Paginated, type PaginationParams } from '../../../core/pagination/pagination.js';
import { countExternalReferences } from '../../../core/records/deletion-guards.js';
import { moveVariantRecords } from '../../../core/records/variant-merge.js';
import { CATALOG_AUDIT, catalogTarget } from '../audit-actions.js';
import type {
  ApproveDraftBody,
  CreateDraftBody,
  DraftsFilterQuery,
  MergeDraftBody,
  WireDraft,
} from '../dtos/drafts.dto.js';
import * as draftsRepository from '../repositories/drafts.repository.js';
import * as productsRepository from '../repositories/products.repository.js';
import { assertCodesFreeOfOtherProducts } from './barcode-ownership.js';
import { barcodeProblem, normalizeBarcode } from './barcode-rules.js';

/**
 * A branch met an unknown barcode at its counter — inventory_suppliers.md §٢.
 *
 * Work does not stop: the branch creates a draft and **receives stock against
 * it**. It cannot be sold (`status: draft`, `is_branch_draft`) because its
 * name, category and picture are nobody's decision yet, and a sale would
 * print a name on an invoice that may change next week.
 *
 * The administration then **approves** it (it becomes an ordinary product),
 * **merges** it into the product it turned out to be (the stock travels with
 * it, through `core/records/variant-merge`), or **deletes** it while it still
 * holds nothing.
 */

const DRAFT_KIND = 'retail' as const;

function ageDays(from: Date): number {
  return Math.floor((Date.now() - from.getTime()) / (24 * 60 * 60 * 1000));
}

export async function createDraft(actor: RequestActorContext, body: CreateDraftBody): Promise<WireDraft> {
  const category = await draftsRepository.findLeafCategory(body.category_id);
  if (!category) throw new BusinessError(422, 'Pick a final-level category', 'category_not_leaf');
  const unit = await draftsRepository.findUnit(body.base_unit_id);
  if (!unit) throw new NotFoundError('Unit not found');

  const code = body.barcode === undefined ? null : normalizeBarcode(body.barcode);
  if (code !== null) {
    const problem = barcodeProblem(code);
    // Shape only — the check digit is not enforced here. A factory code the
    // branch cannot scan cleanly is exactly what a draft is for, and §٧ built
    // the barcode model around accepting a code rather than blocking a
    // delivery.
    if (problem === 'format') throw new BusinessError(422, 'That barcode is not a valid code', 'barcode_format_invalid');
    // But a code an existing product already carries is not an unknown code:
    // scanning it would have found that product, so a draft here would make
    // the same scan offer two items from then on. The refusal names the
    // product the branch was looking for.
    await assertCodesFreeOfOtherProducts([code], null);
  }

  const productId = await db.transaction(async (tx) => {
    const product = await productsRepository.insertProduct(tx, {
      category_id: category.id,
      brand_id: null,
      kind: DRAFT_KIND,
      is_sellable: true,
      name_ar: body.name_ar,
      name_en: body.name_en ?? null,
      description_ar: body.note ?? null,
      description_en: null,
      search_keywords: [],
      search_text: normalizeArabic(body.name_ar),
      price_policy: null,
      pricing_currency: null,
      status: 'draft',
      is_branch_draft: true,
      draft_branch_id: body.branch_id,
      created_by_user_id: actor.userId,
    });
    await productsRepository.replaceProductImages(tx, product.id, body.image_id ? [body.image_id] : []);
    // One variant with no options and one unit — a draft is «this thing on the
    // shelf», and whatever it really varies on is decided at approval.
    await productsRepository.insertVariant(tx, product.id, {
      sku: null,
      combinationKey: '',
      values: [],
      baseUnitId: body.base_unit_id,
      units: [{ unitId: body.base_unit_id, factor: 1, isBase: true, online: true, pos: true }],
      barcodes: code === null ? [] : [{ code, unitId: body.base_unit_id, source: 'manufacturer' as const }],
      imageIds: [],
      sortOrder: 0,
    });
    return product.id;
  });

  await recordAudit(actor, CATALOG_AUDIT.draftCreate, catalogTarget.product(productId), null, {
    branch_id: body.branch_id,
    name_ar: body.name_ar,
    barcode: code,
  });
  return getDraft(productId);
}

export async function getDraft(productId: number): Promise<WireDraft> {
  const draft = await draftsRepository.findDraft(productId);
  if (!draft) throw new NotFoundError('Draft not found');
  return { ...draft, age_days: ageDays(draft.created_at) };
}

export async function listDrafts(
  params: PaginationParams,
  filter: DraftsFilterQuery,
): Promise<Paginated<WireDraft>> {
  const { rows, total } = await draftsRepository.findDrafts(params, {
    branchId: filter.branch_id,
    includeDecided: filter.include_decided === true,
  });
  return paginated(
    rows.map((row) => ({ ...row, age_days: ageDays(row.created_at) })),
    total,
    params,
  );
}

async function requireOpenDraft(productId: number) {
  const product = await productsRepository.findById(productId);
  if (!product) throw new NotFoundError('Draft not found');
  if (!product.is_branch_draft)
    throw new BusinessError(409, 'This product is not a branch draft', 'draft_already_decided', {
      status: product.status,
    });
  return product;
}

/** It is what the branch said it was: it becomes an ordinary, sellable product. */
export async function approveDraft(
  actor: RequestActorContext,
  productId: number,
  body: ApproveDraftBody,
): Promise<WireDraft> {
  const product = await requireOpenDraft(productId);
  if (body.category_id !== undefined) {
    const category = await draftsRepository.findLeafCategory(body.category_id);
    if (!category) throw new BusinessError(422, 'Pick a final-level category', 'category_not_leaf');
  }
  const nameAr = body.name_ar ?? product.name_ar;
  await productsRepository.updateProduct(db, productId, {
    is_branch_draft: false,
    status: 'active',
    ...(body.name_ar !== undefined ? { name_ar: body.name_ar, search_text: normalizeArabic(body.name_ar) } : {}),
    ...(body.name_en !== undefined ? { name_en: body.name_en } : {}),
    ...(body.category_id !== undefined ? { category_id: body.category_id } : {}),
    ...(body.brand_id !== undefined ? { brand_id: body.brand_id } : {}),
  });
  await recordAudit(
    actor,
    CATALOG_AUDIT.draftApprove,
    catalogTarget.product(productId),
    { is_branch_draft: true, status: product.status },
    { is_branch_draft: false, status: 'active', name_ar: nameAr },
  );
  // No longer a draft — the caller reads it as the product it now is.
  return { ...(await draftsRepository.findAnyAsDraft(productId))!, age_days: 0 };
}

/**
 * It was an item we already sell. The draft's stock moves onto that variant,
 * its barcodes come along (that is how the branch will scan it next time),
 * and the draft itself goes.
 */
export async function mergeDraft(
  actor: RequestActorContext,
  productId: number,
  body: MergeDraftBody,
): Promise<{ merged_into_variant_id: number }> {
  const product = await requireOpenDraft(productId);
  const variants = await productsRepository.findVariantsOfProducts([productId]);
  const draftVariant = variants[0];
  if (!draftVariant) throw new BusinessError(409, 'This draft has no variant to merge', 'draft_no_variant');
  if (draftVariant.id === body.variant_id)
    throw new BusinessError(422, 'A draft cannot merge into itself', 'draft_merge_self');
  const target = await productsRepository.findVariantById(body.variant_id);
  if (!target) throw new NotFoundError('Target variant not found');
  const targetProduct = await productsRepository.findById(target.product_id);
  if (targetProduct?.is_branch_draft)
    throw new BusinessError(422, 'Merge into a real product, not another draft', 'draft_merge_into_draft');

  // The ledger moves first and in its own transaction: if it cannot, the
  // draft stays exactly as it was. Deleting the product first would strand
  // the stock on a variant that no longer exists.
  await moveVariantRecords(draftVariant.id, body.variant_id);
  await draftsRepository.moveBarcodes(draftVariant.id, body.variant_id, target.base_unit_id);
  await db.transaction((tx) => productsRepository.hardDeleteProduct(tx, productId));

  await recordAudit(
    actor,
    CATALOG_AUDIT.draftMerge,
    catalogTarget.variant(body.variant_id),
    { draft_product_id: productId, draft_variant_id: draftVariant.id, name_ar: product.name_ar },
    { merged_into_variant_id: body.variant_id },
  );
  return { merged_into_variant_id: body.variant_id };
}

/**
 * Refusing a draft that never held stock. One that did cannot simply vanish —
 * the branch has the goods on its shelf, and the answer is a merge (§٢).
 * The deletion guard (`core/records`) is what turns that into a sentence
 * instead of a foreign-key crash.
 */
export async function deleteDraft(actor: RequestActorContext, productId: number): Promise<void> {
  const product = await requireOpenDraft(productId);
  // The branch received goods against it. Deleting it would take the stock
  // with it — the reviewer's answer is a merge, or an approval.
  if ((await countExternalReferences('product', [productId])) > 0)
    throw new BusinessError(409, 'This draft holds stock — merge it instead', 'draft_has_stock');
  await recordAudit(actor, CATALOG_AUDIT.draftReject, catalogTarget.product(productId), {
    name_ar: product.name_ar,
  }, null);
  await db.transaction((tx) => productsRepository.hardDeleteProduct(tx, productId));
}

