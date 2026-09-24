import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { CATALOG_AUDIT, catalogTarget } from '../audit-actions.js';
import type {
  BulkPriceBody,
  CategoryPricingRulesBody,
  BranchPriceBody,
  CentralPriceBody,
  WireBulkPreview,
  WirePriceHistoryEntry,
  WirePricingSettings,
  WireProductPricing,
  WireResolvedPrice,
  WireVariantPricing,
  WireWorklistItem,
} from '../dtos/pricing.dto.js';
import * as attributesRepository from '../repositories/attributes.repository.js';
import * as categoriesRepository from '../repositories/categories.repository.js';
import { db } from '../../../core/db/client.js';
import * as pricingRepository from '../repositories/pricing.repository.js';
import * as productsRepository from '../repositories/products.repository.js';
import type { PriceContext, StorePrice } from '../../../core/pricing/price-port.js';
import { resolvePromotionsOn } from '../../../core/promotions/promotion-port.js';
import type { PricePolicy, PricingCurrency } from '../schemas/catalog-enums.schema.js';
import type { CatalogProductRow } from '../schemas/products.schema.js';
import { CategoryTree } from './category-tree.js';
import {
  DEFAULT_ROUNDING_BANDS,
  bandOf,
  resolvePrice,
  roundUp,
  toSyp,
  validateRoundingBands,
  type Money,
  type ResolvedPrice,
  type RoundingBand,
} from './price-resolution.js';

/**
 * Prices — store_system.md §١١. The rules live in `price-resolution.ts`; this
 * file loads what they need, checks who may write what, and records history.
 */

const EDIT = 'pricing.edit';

interface PricingContext {
  tree: CategoryTree<Awaited<ReturnType<typeof categoriesRepository.findAll>>[number]>;
  bands: RoundingBand[];
  rate: { usd_to_syp: number; effective_at: Date } | null;
}

async function loadContext(): Promise<PricingContext> {
  const [categories, bands, rate] = await Promise.all([
    categoriesRepository.findAll(),
    pricingRepository.findRoundingBands(),
    pricingRepository.findCurrentRate(),
  ]);
  return {
    tree: new CategoryTree(categories),
    bands: bands ?? [...DEFAULT_ROUNDING_BANDS],
    rate: rate ? { usd_to_syp: Number(rate.usd_to_syp), effective_at: rate.effective_at } : null,
  };
}

interface ProductRules {
  policy: PricePolicy;
  currency: PricingCurrency;
  bandPercent: number | null;
  wholesaleDiscount: number | null;
  wholesaleMinQty: number | null;
  taxRate: number | null;
}

type ProductLike = Pick<CatalogProductRow, 'category_id' | 'price_policy' | 'pricing_currency' | 'price_band_percent'>;

/** The product's effective pricing rules: its own override, else the category chain, else the defaults. */
function rulesOf(ctx: PricingContext, product: ProductLike): ProductRules {
  const c = product.category_id;
  return {
    policy: product.price_policy ?? ctx.tree.effective(c, 'price_policy') ?? 'central_locked',
    currency: product.pricing_currency ?? ctx.tree.effective(c, 'pricing_currency') ?? 'SYP',
    bandPercent:
      product.price_band_percent != null
        ? Number(product.price_band_percent)
        : ctx.tree.effectiveNumber(c, 'price_band_percent'),
    wholesaleDiscount: ctx.tree.effectiveNumber(c, 'wholesale_discount_percent'),
    wholesaleMinQty: ctx.tree.effectiveNumber(c, 'wholesale_min_qty'),
    taxRate: ctx.tree.effectiveNumber(c, 'tax_rate_percent'),
  };
}

const money = (row: { amount: string; currency: PricingCurrency } | undefined): Money | null =>
  row ? { amount: Number(row.amount), currency: row.currency } : null;

function resolveFor(
  ctx: PricingContext,
  rules: ProductRules,
  central: pricingRepository.VariantPriceLike | undefined,
  branch: Money | null,
  isListed: boolean,
): ResolvedPrice {
  return resolvePrice({
    policy: rules.policy,
    isListed,
    central: money(central),
    branch,
    bandPercent: rules.bandPercent,
    usdToSyp: ctx.rate?.usd_to_syp ?? null,
    bands: ctx.bands,
    wholesale: {
      explicit:
        central?.wholesale_amount != null
          ? { amount: Number(central.wholesale_amount), currency: central.currency }
          : null,
      discountPercent: rules.wholesaleDiscount,
      minQty: central?.wholesale_min_qty != null ? Number(central.wholesale_min_qty) : rules.wholesaleMinQty,
    },
  });
}

function toWireResolved(r: ResolvedPrice): WireResolvedPrice {
  switch (r.status) {
    case 'not_listed':
      return { status: 'not_listed' };
    case 'unpriced':
      return { status: 'unpriced', reason: r.reason };
    case 'priced':
      return {
        status: 'priced',
        amount_syp: r.amountSyp,
        source: r.source,
        out_of_band: r.outOfBand,
        band: r.band,
        wholesale: r.wholesale ? { amount_syp: r.wholesale.amountSyp, min_qty: r.wholesale.minQty } : null,
      };
  }
}

// ── The price port (core/pricing) ───────────────────────────────────────────

/**
 * What these variants cost at one branch — the answer the storefront shows.
 *
 * It runs the same `resolvePrice` every administration screen runs, on the
 * same loaded rules, because a second price rule would disagree the first
 * time either moved — and the disagreement is a plausible number on a shelf,
 * with nothing failing anywhere.
 */
export async function resolveAt(
  branchId: number,
  variantIds: number[],
  priceCtx: PriceContext,
): Promise<Map<number, StorePrice>> {
  const result = new Map<number, StorePrice>();
  if (variantIds.length === 0) return result;
  const ctx = await loadContext();
  const variants = await pricingRepository.findVariantsForPricing(variantIds);
  const ids = variants.map((v) => v.variant_id);
  const [central, branchRows, unlisted] = await Promise.all([
    pricingRepository.findVariantPrices(ids),
    pricingRepository.findBranchPrices(ids, branchId),
    pricingRepository.findUnlisted(ids, branchId),
  ]);
  const centralBy = new Map(central.map((c) => [c.variant_id, c]));
  const branchBy = new Map(branchRows.map((b) => [b.variant_id, b]));
  const unlistedSet = new Set(unlisted.map((u) => u.variant_id));

  for (const v of variants) {
    const rules = rulesOf(ctx, {
      category_id: v.category_id,
      price_policy: v.product_price_policy,
      pricing_currency: v.product_currency,
      price_band_percent: v.product_band_percent,
    });
    const resolved = resolveFor(
      ctx,
      rules,
      centralBy.get(v.variant_id),
      money(branchBy.get(v.variant_id)),
      !unlistedSet.has(v.variant_id),
    );
    result.set(v.variant_id, {
      variantId: v.variant_id,
      status: resolved.status === "priced" ? "priced" : resolved.status === "not_listed" ? "not_listed" : "unpriced",
      amountSyp: resolved.status === "priced" ? resolved.amountSyp : null,
      wholesale:
        resolved.status === "priced" && resolved.wholesale
          ? { amountSyp: resolved.wholesale.amountSyp, minQty: resolved.wholesale.minQty }
          : null,
      taxPercent: rules.taxRate,
      promotion: null,
    });
  }

  if (priceCtx.promotions === 'ignore') return result;

  /**
   * العرض يُطبَّق **هنا**، بعد حلّ السعر وقبل أن يغادر الرقم الخادم.
   *
   * تطبيقه بالمتجر وحده كان سيترك كل مستهلك آخر للمنفذ يعرض السعر قبل العرض،
   * والفرق يظهر رقماً معقولاً بمكان وآخر بمكان — بلا أي فشل. والقاعدة نفسها
   * تُسأل مرة واحدة: `core/promotions`.
   *
   * ويُطبَّق على **ما يدفعه هذا المشتري**: سعر الجملة للمعتمَد وسعر التجزئة
   * لغيره. تطبيقه على التجزئة دائماً كان سيعطي تاجر الجملة خصماً على سعرٍ لا
   * يدفعه.
   */
  const priced = variants
    .map((v) => {
      const price = result.get(v.variant_id);
      if (!price || price.status !== 'priced') return null;
      const base =
        priceCtx.segment === 'wholesale' && price.wholesale !== null
          ? price.wholesale.amountSyp
          : price.amountSyp;
      if (base === null) return null;
      return {
        variantId: v.variant_id,
        productId: v.product_id,
        categoryId: v.category_id,
        brandId: v.brand_id ?? null,
        basePriceSyp: base,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const offers = await resolvePromotionsOn(
    { branchId, channel: priceCtx.channel, segment: priceCtx.segment },
    priced,
  );
  for (const [variantId, offer] of offers) {
    const price = result.get(variantId);
    if (!price) continue;
    const applied = {
      beforeSyp: offer.beforeSyp,
      names: offer.names,
      promotionIds: offer.promotionIds,
    };
    if (priceCtx.segment === 'wholesale' && price.wholesale !== null) {
      price.wholesale = { ...price.wholesale, amountSyp: offer.afterSyp };
    } else {
      price.amountSyp = offer.afterSyp;
    }
    price.promotion = applied;
  }
  return result;
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<WirePricingSettings> {
  const [ctx, branches] = await Promise.all([loadContext(), pricingRepository.findLiveBranches()]);
  return {
    branches,
    exchange_rate: ctx.rate
      ? { usd_to_syp: ctx.rate.usd_to_syp, effective_at: ctx.rate.effective_at.toISOString() }
      : null,
    rounding_bands: ctx.bands,
  };
}

export async function setExchangeRate(actor: RequestActorContext, usdToSyp: number): Promise<WirePricingSettings> {
  const before = await pricingRepository.findCurrentRate();
  await pricingRepository.insertRate(usdToSyp, actor.userId);
  await recordAudit(
    actor,
    CATALOG_AUDIT.exchangeRateSet,
    catalogTarget.pricing(),
    { usd_to_syp: before ? Number(before.usd_to_syp) : null },
    { usd_to_syp: usdToSyp },
  );
  return getSettings();
}

export async function setRoundingBands(
  actor: RequestActorContext,
  bands: RoundingBand[],
): Promise<WirePricingSettings> {
  if (validateRoundingBands(bands) !== null)
    throw new BusinessError(422, 'Rounding bands must climb, end open and have positive steps', 'rounding_bands_invalid');
  const before = await pricingRepository.findRoundingBands();
  await pricingRepository.saveRoundingBands(bands, actor.userId);
  await recordAudit(actor, CATALOG_AUDIT.roundingSet, catalogTarget.pricing(), { rounding_bands: before }, {
    rounding_bands: bands,
  });
  return getSettings();
}

// ── One product ─────────────────────────────────────────────────────────────

async function requireProduct(id: number): Promise<CatalogProductRow> {
  const product = await productsRepository.findById(id);
  if (!product) throw new NotFoundError('Product not found');
  return product;
}

async function requireLiveBranch(branchId: number): Promise<{ id: number; name: string }> {
  const branch = (await pricingRepository.findLiveBranches()).find((b) => b.id === branchId);
  if (!branch) throw new NotFoundError('Branch not found');
  return branch;
}

/**
 * The product's prices, seen from one branch ([branchId]) or centrally
 * (`null`: the central price resolved as if no branch had one, plus every
 * branch's own price listed per variant).
 */
export async function getProductPricing(
  actor: RequestActorContext,
  productId: number,
  branchId: number | null,
): Promise<WireProductPricing> {
  const product = await requireProduct(productId);
  if (branchId !== null) await requireLiveBranch(branchId);
  const ctx = await loadContext();
  const rules = rulesOf(ctx, product);
  const variants = await productsRepository.findVariantsOfProducts([productId]);
  const ids = variants.map((v) => v.id);
  const [central, branchRows, unlisted, labels, branches, canCentral, canBranch] = await Promise.all([
    pricingRepository.findVariantPrices(ids),
    pricingRepository.findBranchPrices(ids, branchId ?? undefined),
    pricingRepository.findUnlisted(ids, branchId ?? undefined),
    labelsOf(ids),
    pricingRepository.findLiveBranches(),
    holdsPermissionAt(actor.userId, EDIT, null),
    branchId === null ? Promise.resolve(false) : holdsPermissionAt(actor.userId, EDIT, branchId),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));

  const wireVariants: WireVariantPricing[] = variants.map((v) => {
    const c = central.find((p) => p.variant_id === v.id);
    const own = branchId === null ? undefined : branchRows.find((p) => p.variant_id === v.id);
    const listed = branchId === null || !unlisted.some((u) => u.variant_id === v.id);
    return {
      variant_id: v.id,
      sku: v.sku,
      label_ar: labels.get(v.id) ?? '',
      central: c
        ? {
            amount: Number(c.amount),
            currency: c.currency,
            wholesale_amount: c.wholesale_amount === null ? null : Number(c.wholesale_amount),
            wholesale_min_qty: c.wholesale_min_qty === null ? null : Number(c.wholesale_min_qty),
          }
        : null,
      branch_price: own ? { amount: Number(own.amount), currency: own.currency } : null,
      is_listed: listed,
      resolved: toWireResolved(resolveFor(ctx, rules, c, money(own), listed)),
      branch_prices:
        branchId === null
          ? branchRows
              .filter((p) => p.variant_id === v.id && branchName.has(p.branch_id))
              .map((p) => ({
                branch_id: p.branch_id,
                branch_name: branchName.get(p.branch_id)!,
                amount: Number(p.amount),
                currency: p.currency,
              }))
          : [],
      unlisted_branch_ids:
        branchId === null ? unlisted.filter((u) => u.variant_id === v.id).map((u) => u.branch_id) : [],
    };
  });

  return {
    product_id: product.id,
    branch_id: branchId,
    price_policy: rules.policy,
    pricing_currency: rules.currency,
    band_percent: rules.bandPercent,
    own_band_percent: product.price_band_percent === null ? null : Number(product.price_band_percent),
    wholesale_discount_percent: rules.wholesaleDiscount,
    wholesale_min_qty: rules.wholesaleMinQty,
    tax_rate_percent: rules.taxRate,
    exchange_rate: ctx.rate?.usd_to_syp ?? null,
    can_edit_central: canCentral,
    can_edit_branch: branchId !== null && canBranchPrice(rules.policy, canCentral, canBranch),
    variants: wireVariants,
  };
}

/** A branch price under `central_locked` is an exception only the unrestricted grant may set. */
function canBranchPrice(policy: PricePolicy, unrestricted: boolean, atBranch: boolean): boolean {
  return policy === 'central_locked' ? unrestricted : atBranch;
}

async function labelsOf(variantIds: number[]): Promise<Map<number, string>> {
  const [links, values] = await Promise.all([
    productsRepository.findValuesOfVariants(variantIds),
    attributesRepository.findAllValues(),
  ]);
  const byId = new Map(values.map((v) => [v.id, v.value_ar]));
  const result = new Map<number, string[]>();
  for (const link of links) {
    result.set(link.variant_id, [...(result.get(link.variant_id) ?? []), byId.get(link.attribute_value_id) ?? '']);
  }
  return new Map([...result].map(([id, parts]) => [id, parts.join(' · ')]));
}

async function requireVariantAndProduct(variantId: number) {
  const variant = await productsRepository.findVariantById(variantId);
  if (!variant) throw new NotFoundError('Variant not found');
  const product = await requireProduct(variant.product_id);
  return { variant, product };
}

export async function setCentralPrice(
  actor: RequestActorContext,
  variantId: number,
  body: CentralPriceBody,
): Promise<WireProductPricing> {
  const { variant, product } = await requireVariantAndProduct(variantId);
  if (!(await holdsPermissionAt(actor.userId, EDIT, null)))
    throw new BusinessError(403, 'The central price needs pricing.edit for every branch', 'price_central_only');
  const ctx = await loadContext();
  const rules = rulesOf(ctx, product);
  const currency = body.currency ?? rules.currency;
  if (body.wholesale_amount != null && body.wholesale_amount >= body.amount)
    throw new BusinessError(422, 'A wholesale price must be below the retail price', 'wholesale_not_below_retail');

  const [before] = await pricingRepository.findVariantPrices([variantId]);
  const next = {
    variant_id: variantId,
    amount: body.amount,
    currency,
    wholesale_amount: body.wholesale_amount ?? null,
    wholesale_min_qty: body.wholesale_min_qty ?? null,
  };
  await pricingRepository.upsertVariantPrice(next, actor.userId);
  await pricingRepository.insertHistory(
    centralHistory(variantId, before, next),
    actor.userId,
  );
  await recordAudit(
    actor,
    CATALOG_AUDIT.centralPriceSet,
    catalogTarget.variant(variantId),
    before ? { amount: Number(before.amount), currency: before.currency } : null,
    { amount: body.amount, currency },
  );
  return getProductPricing(actor, variant.product_id, null);
}

function centralHistory(
  variantId: number,
  before: pricingRepository.VariantPriceLike | undefined,
  next: { amount: number; currency: PricingCurrency; wholesale_amount: number | null; wholesale_min_qty: number | null },
): pricingRepository.HistoryEntry[] {
  const num = (v: string | null | undefined) => (v == null ? null : Number(v));
  const entries: pricingRepository.HistoryEntry[] = [];
  const push = (
    field: pricingRepository.HistoryEntry['field'],
    oldAmount: number | null,
    newAmount: number | null,
    withCurrency: boolean,
  ) => {
    // A currency switch matters only to an amount that exists — «none → none»
    // with a new currency is not a change anyone made.
    if (oldAmount === null && newAmount === null) return;
    const currencyChanged = withCurrency && before?.currency !== next.currency;
    if (oldAmount === newAmount && !currencyChanged) return;
    entries.push({
      variant_id: variantId,
      branch_id: null,
      field,
      old_amount: oldAmount,
      old_currency: withCurrency ? (before?.currency ?? null) : null,
      new_amount: newAmount,
      new_currency: withCurrency ? next.currency : null,
      source: 'manual',
    });
  };
  push('retail', num(before?.amount), next.amount, true);
  push('wholesale', num(before?.wholesale_amount), next.wholesale_amount, true);
  push('wholesale_min_qty', num(before?.wholesale_min_qty), next.wholesale_min_qty, false);
  return entries;
}

/** Who may touch the price at this branch, given the product's policy. Throws the refusal the screen shows. */
async function assertBranchWrite(actor: RequestActorContext, branchId: number, policy: PricePolicy): Promise<void> {
  if (policy === 'central_locked') {
    if (!(await holdsPermissionAt(actor.userId, EDIT, null)))
      throw new BusinessError(403, 'This product is priced centrally', 'price_central_only');
    return;
  }
  if (!(await holdsPermissionAt(actor.userId, EDIT, branchId)))
    throw new BusinessError(403, 'No pricing permission at this branch', 'pricing_scope_denied');
}

export async function setBranchPrice(
  actor: RequestActorContext,
  branchId: number,
  variantId: number,
  body: BranchPriceBody,
): Promise<WireProductPricing> {
  const { product } = await requireVariantAndProduct(variantId);
  await requireLiveBranch(branchId);
  const ctx = await loadContext();
  const rules = rulesOf(ctx, product);
  await assertBranchWrite(actor, branchId, rules.policy);
  const currency = body.currency ?? rules.currency;

  if (rules.policy === 'branch_banded') {
    if (rules.bandPercent === null)
      throw new BusinessError(409, 'No price band is set for this category', 'price_band_missing');
    const [central] = await pricingRepository.findVariantPrices([variantId]);
    const centralSyp = central ? toSyp(money(central)!, ctx.rate?.usd_to_syp ?? null, ctx.bands) : null;
    if (centralSyp === null)
      throw new BusinessError(409, 'Set the central price first', 'price_no_central');
    const band = bandOf(centralSyp, rules.bandPercent);
    const asked = toSyp({ amount: body.amount, currency }, ctx.rate?.usd_to_syp ?? null, ctx.bands);
    if (asked === null || asked < band.min - 0.005 || asked > band.max + 0.005)
      throw new BusinessError(422, 'The price is outside the allowed range', 'price_outside_band', {
        min: band.min,
        max: band.max,
      });
  }

  const [before] = await pricingRepository.findBranchPrices([variantId], branchId);
  await pricingRepository.upsertBranchPrice(branchId, variantId, body.amount, currency, actor.userId);
  await pricingRepository.insertHistory(
    [
      {
        variant_id: variantId,
        branch_id: branchId,
        field: 'retail',
        old_amount: before ? Number(before.amount) : null,
        old_currency: before?.currency ?? null,
        new_amount: body.amount,
        new_currency: currency,
        source: 'manual',
      },
    ],
    actor.userId,
  );
  await recordAudit(
    actor,
    CATALOG_AUDIT.branchPriceSet,
    catalogTarget.variant(variantId),
    before ? { branch_id: branchId, amount: Number(before.amount), currency: before.currency } : null,
    { branch_id: branchId, amount: body.amount, currency },
  );
  return getProductPricing(actor, product.id, branchId);
}

export async function clearBranchPrice(
  actor: RequestActorContext,
  branchId: number,
  variantId: number,
): Promise<WireProductPricing> {
  const { product } = await requireVariantAndProduct(variantId);
  await requireLiveBranch(branchId);
  const ctx = await loadContext();
  await assertBranchWrite(actor, branchId, rulesOf(ctx, product).policy);
  const [before] = await pricingRepository.findBranchPrices([variantId], branchId);
  if (before) {
    await pricingRepository.deleteBranchPrice(branchId, variantId);
    await pricingRepository.insertHistory(
      [
        {
          variant_id: variantId,
          branch_id: branchId,
          field: 'retail',
          old_amount: Number(before.amount),
          old_currency: before.currency,
          new_amount: null,
          new_currency: null,
          source: 'manual',
        },
      ],
      actor.userId,
    );
    await recordAudit(
      actor,
      CATALOG_AUDIT.branchPriceClear,
      catalogTarget.variant(variantId),
      { branch_id: branchId, amount: Number(before.amount), currency: before.currency },
      null,
    );
  }
  return getProductPricing(actor, product.id, branchId);
}

/** Withdrawing from a branch is the branch's call (or anyone unrestricted) whatever the price policy. */
export async function setListing(
  actor: RequestActorContext,
  branchId: number,
  variantId: number,
  isListed: boolean,
): Promise<WireProductPricing> {
  const { product } = await requireVariantAndProduct(variantId);
  await requireLiveBranch(branchId);
  if (!(await holdsPermissionAt(actor.userId, EDIT, branchId)))
    throw new BusinessError(403, 'No pricing permission at this branch', 'pricing_scope_denied');
  await pricingRepository.setListing(branchId, variantId, isListed, actor.userId);
  await recordAudit(actor, CATALOG_AUDIT.listingSet, catalogTarget.variant(variantId), null, {
    branch_id: branchId,
    is_listed: isListed,
  });
  return getProductPricing(actor, product.id, branchId);
}

export async function getPriceHistory(variantId: number): Promise<WirePriceHistoryEntry[]> {
  await requireVariantAndProduct(variantId);
  const [rows, branches] = await Promise.all([
    pricingRepository.findHistory(variantId, 100),
    pricingRepository.findLiveBranches(),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  return rows.map((r) => ({
    id: r.id,
    branch_id: r.branch_id,
    branch_name: r.branch_id === null ? null : (branchName.get(r.branch_id) ?? null),
    field: r.field as WirePriceHistoryEntry['field'],
    old_amount: r.old_amount === null ? null : Number(r.old_amount),
    old_currency: r.old_currency,
    new_amount: r.new_amount === null ? null : Number(r.new_amount),
    new_currency: r.new_currency,
    source: r.source as WirePriceHistoryEntry['source'],
    changed_at: r.changed_at.toISOString(),
    changed_by: r.first_name ? `${r.first_name} ${r.last_name ?? ''}`.trim() : null,
  }));
}

// ── The worklist: what needs a price now ────────────────────────────────────

/**
 * Sellable variants with no price at [branchId] (or centrally, when `null`),
 * and branch prices the moving central price pushed out of their band. The
 * signal §٣ promised: "unpriced" is never shown to a customer, so it must be
 * shown to someone who can fix it.
 */
export async function getWorklist(branchId: number | null, limit = 200): Promise<{
  total: number;
  items: WireWorklistItem[];
}> {
  if (branchId !== null) await requireLiveBranch(branchId);
  const ctx = await loadContext();
  const variants = await pricingRepository.findSellableVariants();
  const ids = variants.map((v) => v.variant_id);
  const [central, branchRows, unlisted, labels] = await Promise.all([
    pricingRepository.findVariantPrices(ids),
    branchId === null ? Promise.resolve([]) : pricingRepository.findBranchPrices(ids, branchId),
    branchId === null ? Promise.resolve([]) : pricingRepository.findUnlisted(ids, branchId),
    labelsOf(ids),
  ]);
  const centralBy = new Map(central.map((c) => [c.variant_id, c]));
  const branchBy = new Map(branchRows.map((b) => [b.variant_id, b]));
  const unlistedSet = new Set(unlisted.map((u) => u.variant_id));

  const items: WireWorklistItem[] = [];
  for (const v of variants) {
    const rules = rulesOf(ctx, {
      category_id: v.category_id,
      price_policy: v.product_price_policy,
      pricing_currency: null,
      price_band_percent: v.product_band_percent,
    });
    const r = resolveFor(ctx, rules, centralBy.get(v.variant_id), money(branchBy.get(v.variant_id)), !unlistedSet.has(v.variant_id));
    const problem =
      r.status === 'unpriced' ? r.reason : r.status === 'priced' && r.outOfBand ? ('out_of_band' as const) : null;
    if (problem === null) continue;
    items.push({
      variant_id: v.variant_id,
      product_id: v.product_id,
      product_name_ar: v.product_name_ar,
      product_name_en: v.product_name_en,
      sku: v.sku,
      label_ar: labels.get(v.variant_id) ?? '',
      problem,
    });
  }
  return { total: items.length, items: items.slice(0, limit) };
}

// ── Bulk ────────────────────────────────────────────────────────────────────

interface BulkChange {
  variant_id: number;
  sku: string;
  product_name_ar: string;
  currency: PricingCurrency;
  old_amount: number;
  new_amount: number;
  change_syp: number | null;
}

async function planBulk(body: BulkPriceBody): Promise<{ changes: BulkChange[]; skipped: number; ctx: PricingContext }> {
  const ctx = await loadContext();
  let categoryIds: number[] | undefined;
  if (body.category_id !== undefined) {
    if (!ctx.tree.get(body.category_id)) throw new NotFoundError('Category not found');
    categoryIds = [body.category_id, ...ctx.tree.descendantIdsOf(body.category_id)];
  }
  const variants = await pricingRepository.findLiveVariantsIn({ categoryIds, brandId: body.brand_id });
  const prices = await pricingRepository.findVariantPrices(variants.map((v) => v.variant_id));
  const priceBy = new Map(prices.map((p) => [p.variant_id, p]));
  const factor = 1 + body.percent / 100;
  const rate = ctx.rate?.usd_to_syp ?? null;

  const changes: BulkChange[] = [];
  let skipped = 0;
  for (const v of variants) {
    const p = priceBy.get(v.variant_id);
    if (!p) {
      skipped++;
      continue;
    }
    const old = Number(p.amount);
    // A percentage makes a computed number, so a SYP price is rounded like any
    // computed one; a USD price keeps cents and is rounded when converted.
    const next = p.currency === 'SYP' ? roundUp(old * factor, ctx.bands) : Math.round(old * factor * 100) / 100;
    if (next === old || next <= 0) {
      skipped++;
      continue;
    }
    const oldSyp = toSyp({ amount: old, currency: p.currency }, rate, ctx.bands);
    const newSyp = toSyp({ amount: next, currency: p.currency }, rate, ctx.bands);
    changes.push({
      variant_id: v.variant_id,
      sku: v.sku,
      product_name_ar: v.product_name_ar,
      currency: p.currency,
      old_amount: old,
      new_amount: next,
      change_syp: oldSyp === null || newSyp === null ? null : newSyp - oldSyp,
    });
  }
  return { changes, skipped, ctx };
}

function summarise(changes: BulkChange[], skipped: number): WireBulkPreview {
  const deltas = changes.map((c) => c.change_syp).filter((d): d is number => d !== null);
  return {
    count: changes.length,
    skipped,
    largest_change_syp: deltas.length ? Math.max(...deltas.map(Math.abs)) : null,
    smallest_change_syp: deltas.length ? Math.min(...deltas.map(Math.abs)) : null,
    samples: changes.slice(0, 10).map((c) => ({
      variant_id: c.variant_id,
      sku: c.sku,
      product_name_ar: c.product_name_ar,
      currency: c.currency,
      old_amount: c.old_amount,
      new_amount: c.new_amount,
    })),
  };
}

export async function previewBulk(body: BulkPriceBody): Promise<WireBulkPreview> {
  const { changes, skipped } = await planBulk(body);
  return summarise(changes, skipped);
}

/** Re-plans rather than trusting the preview: prices may have moved between the two taps. */
export async function applyBulk(actor: RequestActorContext, body: BulkPriceBody): Promise<WireBulkPreview> {
  const { changes, skipped } = await planBulk(body);
  if (changes.length > 0) {
    await pricingRepository.bulkUpdateCentral(
      changes.map((c) => ({ variant_id: c.variant_id, amount: c.new_amount, currency: c.currency, old_amount: c.old_amount })),
      actor.userId,
    );
    await recordAudit(actor, CATALOG_AUDIT.bulkPriceUpdate, catalogTarget.pricing(), null, {
      category_id: body.category_id ?? null,
      brand_id: body.brand_id ?? null,
      percent: body.percent,
      count: changes.length,
    });
  }
  return summarise(changes, skipped);
}

// ── Rules (pricing.policy) ──────────────────────────────────────────────────

const str = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : String(v));

/** Sets a category's pricing rules. Returns nothing: the caller re-reads the category detail, which carries them. */
export async function setCategoryRules(
  actor: RequestActorContext,
  categoryId: number,
  body: CategoryPricingRulesBody,
): Promise<void> {
  const before = await categoriesRepository.findById(categoryId);
  if (!before) throw new NotFoundError('Category not found');
  const patch = {
    price_band_percent: str(body.price_band_percent),
    wholesale_discount_percent: str(body.wholesale_discount_percent),
    wholesale_min_qty: str(body.wholesale_min_qty),
    tax_rate_percent: str(body.tax_rate_percent),
  };
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  await categoriesRepository.update(categoryId, defined);
  await recordAudit(
    actor,
    CATALOG_AUDIT.categoryPricingRules,
    catalogTarget.category(categoryId),
    Object.fromEntries(Object.keys(defined).map((k) => [k, before[k as keyof typeof patch]])),
    defined,
  );
}

export async function setProductBand(
  actor: RequestActorContext,
  productId: number,
  bandPercent: number | null,
): Promise<WireProductPricing> {
  const before = await requireProduct(productId);
  await productsRepository.updateProduct(db, productId, { price_band_percent: str(bandPercent) ?? null });
  await recordAudit(
    actor,
    CATALOG_AUDIT.productPricingRules,
    catalogTarget.product(productId),
    { price_band_percent: before.price_band_percent },
    { price_band_percent: bandPercent },
  );
  return getProductPricing(actor, productId, null);
}
