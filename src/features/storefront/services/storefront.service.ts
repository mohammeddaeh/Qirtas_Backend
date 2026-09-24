import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';
import { publicImagesByIds, type WireImage } from '../../../core/media/media.service.js';
import { paginated, type PaginationParams, type Paginated } from '../../../core/pagination/pagination.js';
import { resolvePricesAt, type PriceContext, type StorePrice } from '../../../core/pricing/price-port.js';
import type {
  StorefrontProductsQuery,
  WireAlternative,
  WireDemand,
  WireOtherBranch,
  WireStorefrontCategory,
  WireStorefrontCollection,
  WireStorefrontPrice,
  WireStorefrontProduct,
  WireStorefrontProductDetail,
  WireStorefrontVariant,
} from '../dtos/storefront.dto.js';
import * as demandRepository from '../repositories/demand.repository.js';
import * as repository from '../repositories/storefront.repository.js';
import {
  availabilityOf,
  bestOf,
  distanceKm,
  publicStateOf,
  type Availability,
  type OtherBranchStock,
} from './availability-rules.js';

/**
 * The shop as a customer sees it — store_system.md §٨.
 *
 * Two rules run through every function here:
 *
 * 1. **The server decides, the client shows.** Availability and price are
 *    computed here for the chosen branch; a client that recomputed either
 *    would disagree the first time a rule moved, and the disagreement reads as
 *    a correct-looking price on a shelf.
 * 2. **Nothing the customer cannot act on is named.** `unpriced` is our fault,
 *    not a fact about the goods, so it never travels as itself (§٨).
 */

export interface ViewerContext {
  branchId: number;
  /** Where the customer is, when they said — only used to name a distance. */
  lat: number | null;
  lng: number | null;
  /** `null` للضيف — طلباته لا تُسجَّل أصلاً (§٨). */
  customerId: number | null;

  /**
   * A buyer the administration approved for wholesale. Read from the session,
   * never from the request: a flag the client could send would be a discount
   * anybody could ask for.
   */
  isWholesale: boolean;
}

async function requireLiveBranch(branchId: number) {
  const branch = await repository.findBranch(branchId);
  // A closed or archived branch is not a place to shop: the answer is «اختر
  // فرعاً آخر», not a catalogue of things nobody can hand over.
  if (!branch || branch.archived_at !== null || branch.status !== 'active') {
    throw new BusinessError(404, 'This branch is not open for shopping', 'branch_not_shoppable');
  }
  return branch;
}

const num = (value: string | number | null): number => (value === null ? 0 : Number(value));

/**
 * ما يُسأل عنه منفذ السعر من هنا: **المتجر دائماً `online`**، والعروض تُطبَّق.
 *
 * القناة ليست خياراً يُمرَّر من الطلب: عرضُ الكاشير الذي يظهر بالمتجر يُخسِّر
 * مرتين، وقيمةٌ يرسلها العميل تجعل كل زائر يختار أي العروض تنطبق عليه.
 */
const priceContextFor = (viewer: ViewerContext): PriceContext => ({
  promotions: 'apply',
  channel: 'online',
  segment: viewer.isWholesale ? 'wholesale' : 'retail',
});

function priceOf(price: StorePrice | undefined, isWholesale: boolean): WireStorefrontPrice | null {
  if (!price || price.status !== 'priced' || price.amountSyp === null) return null;
  return {
    amount_syp: price.amountSyp,
    was_syp: price.promotion?.beforeSyp ?? null,
    promotion_names: price.promotion?.names ?? [],
    // Shown to an approved buyer only — and beside the retail amount, so the
    // approval's worth is visible rather than merely applied.
    wholesale:
      isWholesale && price.wholesale
        ? { amount_syp: price.wholesale.amountSyp, min_qty: price.wholesale.minQty }
        : null,
  };
}

function otherBranchWire(stock: OtherBranchStock | null): WireOtherBranch | null {
  return stock === null ? null : { id: stock.branchId, name: stock.name, distance_km: stock.distanceKm };
}

/** Nearest first where a distance is known, then by the largest holding: a
 *  customer with no location still gets the branch most likely to have it. */
function sortBranches(list: OtherBranchStock[]): OtherBranchStock[] {
  return [...list].sort((a, b) => {
    if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
    if (a.distanceKm !== null) return -1;
    if (b.distanceKm !== null) return 1;
    return b.onHand - a.onHand;
  });
}

interface VariantView {
  variantId: number;
  productId: number;
  sku: string;
  state: Availability;
  remaining: number | null;
  otherBranch: OtherBranchStock | null;
  price: StorePrice | undefined;
  hidden: boolean;
}

/** The whole availability picture for a set of variants at one branch. */
async function viewVariants(
  viewer: ViewerContext,
  products: { id: number; status: string }[],
  variants: { id: number; product_id: number; sku: string }[],
): Promise<Map<number, VariantView>> {
  const ids = variants.map((v) => v.id);
  const [prices, here, elsewhere] = await Promise.all([
    resolvePricesAt(viewer.branchId, ids, priceContextFor(viewer)),
    repository.findStockAt(viewer.branchId, ids),
    repository.findStockElsewhere(viewer.branchId, ids),
  ]);
  const hereBy = new Map(here.map((row) => [row.variant_id, num(row.on_hand) - num(row.reserved)]));
  const elsewhereBy = new Map<number, OtherBranchStock[]>();
  for (const row of elsewhere) {
    const available = num(row.on_hand) - num(row.reserved);
    if (available <= 0) continue;
    const entry: OtherBranchStock = {
      branchId: row.branch_id,
      name: row.branch_name,
      onHand: available,
      distanceKm: distanceKm(
        { lat: viewer.lat, lng: viewer.lng },
        { lat: row.latitude === null ? null : Number(row.latitude), lng: row.longitude === null ? null : Number(row.longitude) },
      ),
    };
    elsewhereBy.set(row.variant_id, [...(elsewhereBy.get(row.variant_id) ?? []), entry]);
  }

  const statusOf = new Map(products.map((p) => [p.id, p.status]));
  const views = new Map<number, VariantView>();
  for (const variant of variants) {
    const price = prices.get(variant.id);
    const outcome = availabilityOf({
      productStatus: statusOf.get(variant.product_id) ?? 'draft',
      isListedHere: price?.status !== 'not_listed',
      isPricedHere: price?.status === 'priced',
      availableHere: hereBy.get(variant.id) ?? 0,
      elsewhere: sortBranches(elsewhereBy.get(variant.id) ?? []),
    });
    views.set(variant.id, {
      variantId: variant.id,
      productId: variant.product_id,
      sku: variant.sku,
      state: outcome.state,
      remaining: outcome.remaining,
      otherBranch: outcome.otherBranch,
      price,
      hidden: outcome.hiddenFromBrowsing,
    });
  }
  return views;
}

export async function listProducts(
  viewer: ViewerContext,
  params: PaginationParams,
  query: { category_id?: number; collection_id?: number; search?: string },
): Promise<Paginated<WireStorefrontProduct>> {
  await requireLiveBranch(viewer.branchId);
  const categoryIds = query.category_id === undefined ? undefined : await descendantsOf(query.category_id);
  const { rows, total } = await repository.findProducts(params, {
    branchId: viewer.branchId,
    searchFolded: query.search === undefined ? undefined : normalizeArabic(query.search),
    categoryIds,
    collectionId: query.collection_id,
  });
  if (rows.length === 0) return paginated([], total, params);

  const productIds = rows.map((row) => row.id);
  const [variants, links, brands] = await Promise.all([
    repository.findActiveVariants(productIds),
    repository.findImageLinks(productIds),
    repository.findBrandNames([...new Set(rows.map((r) => r.brand_id).filter((id): id is number => id !== null))]),
  ]);
  const views = await viewVariants(viewer, rows, variants);
  const images = await publicImagesByIds([...new Set(links.map((l) => l.media_id))]);
  const brandName = new Map(brands.map((b) => [b.id, b.name]));

  const items: WireStorefrontProduct[] = [];
  for (const row of rows) {
    const own = variants.filter((v) => v.product_id === row.id).map((v) => views.get(v.id)!);
    const state = bestOf(own.map((view) => view.state));
    // A product whose every variant is hidden is not listed as «غير متوفّر» —
    // it is not shown at all: a row a customer can neither buy nor act on is
    // a dead end dressed as a result.
    if (own.length === 0 || own.every((view) => view.hidden)) continue;
    const best = own.find((view) => view.state === state);
    const cheapest = own
      .map((view) => priceOf(view.price, viewer.isWholesale))
      .filter((price): price is WireStorefrontPrice => price !== null)
      .sort((a, b) => a.amount_syp - b.amount_syp)[0];
    const thumbLink = links.find((l) => l.product_id === row.id);
    items.push({
      id: row.id,
      name_ar: row.name_ar,
      name_en: row.name_en,
      brand_name: row.brand_id === null ? null : (brandName.get(row.brand_id) ?? null),
      category_id: row.category_id,
      thumbnail: thumbLink ? (images.get(thumbLink.media_id) ?? null) : null,
      availability: publicStateOf(state),
      price: cheapest ?? null,
      remaining: best?.remaining ?? null,
      other_branch: otherBranchWire(best?.otherBranch ?? null),
      variant_count: own.length,
    });
  }
  return paginated(items, total, params);
}

/**
 * بدائل بجانب حالةٍ غير متاحة (§٨): **من نفس التصنيف، وعلى رفّ هذا الفرع**،
 * وأقربها سعراً لما كان الزبون ينظر إليه.
 *
 * لا تُحسب إطلاقاً حين يستطيع الزبون الشراء: اقتراحٌ بجانب بضاعة متوفّرة
 * يزاحم ما جاء لأجله، وبجانب «نفد» هو الفرق بين طريق مسدود وبيعٍ آخر.
 */
async function alternativesFor(
  viewer: ViewerContext,
  product: { id: number; category_id: number },
  referenceSyp: number | null,
): Promise<WireAlternative[]> {
  const siblings = await repository.findInStockSiblings([product.category_id], viewer.branchId, product.id, 60);
  if (siblings.length === 0) return [];
  const prices = await resolvePricesAt(
    viewer.branchId,
    siblings.map((row) => row.variant_id),
    priceContextFor(viewer),
  );

  const byProduct = new Map<number, { row: (typeof siblings)[number]; amountSyp: number }>();
  for (const row of siblings) {
    if (num(row.on_hand) - num(row.reserved) <= 0) continue;
    const price = prices.get(row.variant_id);
    if (!price || price.status !== 'priced' || price.amountSyp === null) continue;
    // أرخص متغيّر يمثّل منتجه: الاقتراح يُفتح على ما يستطيع الزبون أخذه.
    const current = byProduct.get(row.product_id);
    if (current === undefined || price.amountSyp < current.amountSyp) {
      byProduct.set(row.product_id, { row, amountSyp: price.amountSyp });
    }
  }
  if (byProduct.size === 0) return [];

  const ranked = [...byProduct.values()].sort((a, b) => {
    // القرب بالسعر حين نعرف سعر الأصل؛ وإلا فالأرخص أولاً — «بديل» بضعف
    // الثمن ليس بديلاً.
    if (referenceSyp === null) return a.amountSyp - b.amountSyp;
    return Math.abs(a.amountSyp - referenceSyp) - Math.abs(b.amountSyp - referenceSyp);
  });

  const top = ranked.slice(0, 5);
  const links = await repository.findImageLinks(top.map((entry) => entry.row.product_id));
  const images = await publicImagesByIds([...new Set(links.map((link) => link.media_id))]);
  return top.map((entry) => {
    const link = links.find((row) => row.product_id === entry.row.product_id);
    return {
      product_id: entry.row.product_id,
      name_ar: entry.row.name_ar,
      name_en: entry.row.name_en,
      price_syp: entry.amountSyp,
      thumbnail: link ? (images.get(link.media_id) ?? null) : null,
    };
  });
}

export async function getProduct(
  viewer: ViewerContext,
  productId: number,
): Promise<WireStorefrontProductDetail> {
  await requireLiveBranch(viewer.branchId);
  const product = await repository.findPublishedProduct(productId);
  if (!product) throw new NotFoundError('Product not found');

  const [variants, links, categories] = await Promise.all([
    repository.findActiveVariants([productId]),
    repository.findImageLinks([productId]),
    repository.findActiveCategories(),
  ]);
  const ids = variants.map((v) => v.id);
  const [views, labels, units, images, prices] = await Promise.all([
    viewVariants(viewer, [product], variants),
    repository.findVariantLabels(ids),
    repository.findSellableUnits(ids),
    publicImagesByIds([...new Set(links.map((l) => l.media_id))]),
    resolvePricesAt(viewer.branchId, ids, priceContextFor(viewer)),
  ]);

  const imagesOf = (variantId: number | null): WireImage[] =>
    links
      .filter((l) => l.variant_id === variantId)
      .map((l) => images.get(l.media_id))
      .filter((image): image is WireImage => image !== undefined);

  const wireVariants: WireStorefrontVariant[] = variants.map((variant) => {
    const view = views.get(variant.id)!;
    const price = priceOf(view.price, viewer.isWholesale);
    const own = imagesOf(variant.id);
    return {
      variant_id: variant.id,
      sku: variant.sku,
      label_ar: labels.get(variant.id) ?? '',
      // A variant with no picture of its own shows the product's (§٩) — a
      // colour with an empty frame reads as a missing product, not a missing
      // photograph.
      images: own.length > 0 ? own : imagesOf(null),
      availability: publicStateOf(view.state),
      price,
      remaining: view.remaining,
      other_branch: otherBranchWire(view.otherBranch),
      units: units
        .filter((unit) => unit.variant_id === variant.id)
        .map((unit) => ({
          unit_id: unit.unit_id,
          name_ar: unit.name_ar,
          factor: Number(unit.factor),
          is_base: unit.is_base,
          // The base price times the factor: the shop keeps one price per
          // item, and a carton is twelve of them.
          price_syp: price === null ? null : price.amount_syp * Number(unit.factor),
        })),
    };
  });

  const taxPercent = [...prices.values()].find((price) => price.taxPercent !== null)?.taxPercent ?? null;
  const shown = wireVariants.find((variant) => variant.variant_id === (product_first(wireVariants)?.variant_id ?? -1));
  const buyable = wireVariants.some((variant) => variant.availability === 'available' || variant.availability === 'low_stock');
  const [alternatives, myRequests] = await Promise.all([
    buyable ? Promise.resolve<WireAlternative[]>([]) : alternativesFor(viewer, product, shown?.price?.amount_syp ?? null),
    myDemands(viewer, ids),
  ]);
  return {
    id: product.id,
    name_ar: product.name_ar,
    name_en: product.name_en,
    description_ar: product.description_ar,
    description_en: product.description_en,
    brand_name: null,
    category_id: product.category_id,
    category_name_ar: categories.find((c) => c.id === product.category_id)?.name_ar ?? '',
    images: imagesOf(null),
    availability: publicStateOf(bestOf([...views.values()].map((view) => view.state))),
    tax_percent: taxPercent,
    variants: wireVariants,
    alternatives,
    my_requests: myRequests,
  };
}

export async function listCategories(): Promise<WireStorefrontCategory[]> {
  const [categories, counts] = await Promise.all([
    repository.findActiveCategories(),
    repository.countProductsPerCategory(),
  ]);
  // A parent's count includes everything beneath it: «أدوات الكتابة» holds no
  // products itself, and a zero there would read as an empty aisle.
  const childrenOf = new Map<number, number[]>();
  for (const category of categories) {
    if (category.parent_id === null) continue;
    childrenOf.set(category.parent_id, [...(childrenOf.get(category.parent_id) ?? []), category.id]);
  }
  const totalOf = (id: number): number =>
    (counts.get(id) ?? 0) + (childrenOf.get(id) ?? []).reduce((sum, child) => sum + totalOf(child), 0);

  return categories.map((category) => ({
    id: category.id,
    parent_id: category.parent_id,
    level: category.level,
    name_ar: category.name_ar,
    name_en: category.name_en,
    product_count: totalOf(category.id),
  }));
}

export async function listCollections(): Promise<WireStorefrontCollection[]> {
  const collections = await repository.findVisibleCollections(new Date());
  const [counts, images] = await Promise.all([
    repository.countProductsPerCollection(collections.map((c) => c.id)),
    publicImagesByIds([
      ...new Set(collections.map((c) => c.image_id).filter((id): id is number => id !== null)),
    ]),
  ]);
  return collections.map((collection) => ({
    id: collection.id,
    name_ar: collection.name_ar,
    name_en: collection.name_en,
    image: collection.image_id === null ? null : (images.get(collection.image_id) ?? null),
    product_count: counts.get(collection.id) ?? 0,
  }));
}

/** A category and everything under it — «أقلام» means its subtypes too. */
async function descendantsOf(categoryId: number): Promise<number[]> {
  const categories = await repository.findActiveCategories();
  const ids = [categoryId];
  for (let i = 0; i < ids.length; i++) {
    for (const category of categories) {
      if (category.parent_id === ids[i] && !ids.includes(category.id)) ids.push(category.id);
    }
  }
  return ids;
}

export type { StorefrontProductsQuery };

/** أول متغيّر يُعرض — منه يُؤخذ السعر المرجعي للاقتراحات. */
function product_first(variants: WireStorefrontVariant[]): WireStorefrontVariant | undefined {
  return variants.find((variant) => variant.availability === 'available' || variant.availability === 'low_stock') ?? variants[0];
}

/** ما سجّله هذا الزبون على متغيّرات هذا المنتج — فارغة للضيف. */
async function myDemands(viewer: ViewerContext, variantIds: number[]): Promise<WireDemand[]> {
  if (viewer.customerId === null || variantIds.length === 0) return [];
  const rows = await demandRepository.findMineFor(viewer.customerId, viewer.branchId, variantIds);
  return rows.map((row) => ({
    id: row.id,
    variant_id: row.variant_id,
    branch_id: row.branch_id,
    kind: row.kind,
    created_at: row.created_at.toISOString(),
  }));
}
