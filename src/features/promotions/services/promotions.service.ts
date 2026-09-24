import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { resolveAvgCostAt } from '../../../core/costing/cost-port.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { resolvePricesAt, type PriceContext } from '../../../core/pricing/price-port.js';
import type {
  PromotionPriceContext,
  PromotionPriceItem,
  PromotionOnPrice,
} from '../../../core/promotions/promotion-port.js';
import { PROMOTION_AUDIT, promotionTarget } from '../audit-actions.js';
import * as repo from '../repositories/promotions.repository.js';
import type { PromotionRow } from '../schemas/promotions.schema.js';
import {
  DEFAULT_BRANCH_CAP_PERCENT,
  applyBasket,
  capApplies,
  lossWarningsFor,
  maxPercentOf,
  resolveLine,
  statusOf,
  type Promotion,
  type PromotionContext,
  type PromotionItem,
} from './promotion-rules.js';

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * **السعر قبل أي عرض** — وهو ما يطلبه هذا الموديول دائماً.
 *
 * حارس الخسارة والمعاينة يطبّقان العرض بأنفسهما، فطلبُ سعرٍ مخصوم أصلاً كان
 * يخصم مرتين: تحذيرٌ يظهر لعرضٍ رابح، ومعاينةٌ تعرض سعراً لا يُباع به أحد.
 * ولا شيء يفشل — الرقمان كلاهما معقول.
 */
const BASE_PRICES: PriceContext = { promotions: 'ignore', channel: 'online', segment: 'retail' };

// ── من صفّ القاعدة إلى الكيان الذي تفهمه القواعد ─────────────────────────────

function targetOf(row: PromotionRow): Promotion['target'] {
  if (row.variant_id !== null) return { kind: 'variant', id: row.variant_id };
  if (row.product_id !== null) return { kind: 'product', id: row.product_id };
  if (row.category_id !== null) return { kind: 'category', id: row.category_id };
  if (row.brand_id !== null) return { kind: 'brand', id: row.brand_id };
  // يمنعه قيد `promotion_one_target`؛ والوصول إلى هنا عطلٌ يُقال لا يُخمَّن.
  throw new Error(`Promotion ${row.id} has no target`);
}

function toPromotion(
  row: PromotionRow,
  branchIds: number[] | null,
  tiers: { min_qty: number; percent_value: string | null; amount_syp: string | null }[],
): Promotion {
  return {
    id: row.id,
    nameAr: row.name_ar,
    kind: row.kind,
    target: targetOf(row),
    branchIds: row.scope === 'all_branches' ? null : (branchIds ?? []),
    percent: num(row.percent_value),
    amountSyp: num(row.amount_syp),
    buyQty: row.buy_qty,
    getQty: row.get_qty,
    getPercent: num(row.get_percent),
    tiers: tiers.map((t) => ({
      minQty: t.min_qty,
      percent: num(t.percent_value),
      amountSyp: num(t.amount_syp),
    })),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    channel: row.channel,
    segment: row.segment,
    isStackable: row.is_stackable,
    isActive: row.is_active,
    archivedAt: row.archived_at,
  };
}

/** الصفوف كاملةً مع فروعها وشرائحها — نداءان لا نداء لكل صف. */
async function hydrate(rows: PromotionRow[]): Promise<Promotion[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [links, tiers] = await Promise.all([repo.findBranchLinks(ids), repo.findTiers(ids)]);
  const branchesBy = new Map<number, number[]>();
  for (const l of links) {
    const list = branchesBy.get(l.promotion_id) ?? [];
    list.push(l.branch_id);
    branchesBy.set(l.promotion_id, list);
  }
  const tiersBy = new Map<number, typeof tiers>();
  for (const t of tiers) {
    const list = tiersBy.get(t.promotion_id) ?? [];
    list.push(t);
    tiersBy.set(t.promotion_id, list);
  }
  return rows.map((r) => toPromotion(r, branchesBy.get(r.id) ?? [], tiersBy.get(r.id) ?? []));
}

// ── المنفذ: ما يُحسم عن السعر ────────────────────────────────────────────────

/**
 * مسار التصنيف لكل تصنيف — العرض على الأب يشمل ما تحته، والشجرة ثلاثة مستويات.
 *
 * تُقرأ كاملةً بنداء واحد لأنها ١٤٦ صفاً: استعلامٌ تعاودي لكل صنف بصفحة منتجات
 * يجعل تصفّح المتجر يدفع ثمن ميزة إدارية.
 */
async function categoryPaths(): Promise<Map<number, number[]>> {
  const rows = await repo.findCategoryParents();
  const parentOf = new Map(rows.map((r) => [r.id, r.parent_id]));
  const paths = new Map<number, number[]>();
  for (const row of rows) {
    const path: number[] = [];
    let cursor: number | null = row.id;
    // السقف حارسٌ ضد حلقةٍ بالبيانات — شجرةٌ دائرية كانت ستُعلّق كل طلب متجر.
    for (let depth = 0; cursor !== null && depth < 10; depth += 1) {
      path.push(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    paths.set(row.id, path);
  }
  return paths;
}

export async function resolveOn(
  ctx: PromotionPriceContext,
  items: PromotionPriceItem[],
): Promise<Map<number, PromotionOnPrice>> {
  const out = new Map<number, PromotionOnPrice>();
  if (items.length === 0) return out;
  const candidates = await hydrate(await repo.findCandidates());
  if (candidates.length === 0) return out;
  const paths = await categoryPaths();
  const ruleCtx: PromotionContext = { ...ctx, now: new Date() };

  for (const item of items) {
    const outcome = resolveLine(
      candidates,
      {
        variantId: item.variantId,
        productId: item.productId,
        categoryPath: item.categoryId === null ? [] : (paths.get(item.categoryId) ?? [item.categoryId]),
        brandId: item.brandId,
        basePriceSyp: item.basePriceSyp,
        // سعر الواجهة يُعرض للقطعة الواحدة؛ شرائح الكمية تُقال بجدولها لا بالسعر.
        qty: 1,
      },
      ruleCtx,
    );
    if (outcome.applied.length === 0) continue;
    out.set(item.variantId, {
      variantId: item.variantId,
      beforeSyp: outcome.unitBeforeSyp,
      afterSyp: outcome.unitAfterSyp,
      names: outcome.applied.map((a) => a.nameAr),
      promotionIds: outcome.applied.map((a) => a.promotionId),
    });
  }
  return out;
}

// ── القراءة ─────────────────────────────────────────────────────────────────

export interface WirePromotion {
  id: number;
  name_ar: string;
  name_en: string | null;
  status: ReturnType<typeof statusOf>;
  scope: PromotionRow['scope'];
  branch_ids: number[];
  target_kind: PromotionRow['target_kind'];
  target_id: number;
  target_label: string | null;
  kind: PromotionRow['kind'];
  percent_value: number | null;
  amount_syp: number | null;
  buy_qty: number | null;
  get_qty: number | null;
  get_percent: number | null;
  tiers: { min_qty: number; percent_value: number | null; amount_syp: number | null }[];
  starts_at: string | null;
  ends_at: string | null;
  channel: PromotionRow['channel'];
  segment: PromotionRow['segment'];
  is_stackable: boolean;
  is_active: boolean;
  /** أقصى نسبة يصل إليها العرض — به يُقرأ السقف، وبه يُقارن عرضان بلا حساب يدوي. */
  max_discount_percent: number;
  is_deletable: boolean;
  is_archivable: boolean;
  created_at: string;
}

function wire(row: PromotionRow, promo: Promotion, label: string | null, now: Date): WirePromotion {
  const status = statusOf(promo, now);
  return {
    id: row.id,
    name_ar: row.name_ar,
    name_en: row.name_en,
    status,
    scope: row.scope,
    branch_ids: promo.branchIds ?? [],
    target_kind: row.target_kind,
    target_id: promo.target.id,
    target_label: label,
    kind: row.kind,
    percent_value: num(row.percent_value),
    amount_syp: num(row.amount_syp),
    buy_qty: row.buy_qty,
    get_qty: row.get_qty,
    get_percent: num(row.get_percent),
    tiers: promo.tiers.map((t) => ({
      min_qty: t.minQty,
      percent_value: t.percent,
      amount_syp: t.amountSyp,
    })),
    starts_at: row.starts_at?.toISOString() ?? null,
    ends_at: row.ends_at?.toISOString() ?? null,
    channel: row.channel,
    segment: row.segment,
    is_stackable: row.is_stackable,
    is_active: row.is_active,
    // بسعرٍ افتراضي ١٠٠: النسبة تُقرأ نسبةً، والمبلغ الثابت يُقرأ بما يعادله.
    max_discount_percent: Math.round(maxPercentOf(promo, 100) * 100) / 100,
    /**
     * لا بيع بعد، فلا شيء يشير إلى عرض — والحذف مسموح اليوم لكل عرض.
     * **ويُقرأ من هنا لا يُشتقّ بالعميل**: يوم تُبنى الفواتير يتغيّر الحكم
     * بمكان واحد، ولا تبقى شاشةٌ تعرض زرّاً يرفضه الخادم.
     */
    is_deletable: row.archived_at === null,
    is_archivable: row.archived_at === null,
    created_at: row.created_at.toISOString(),
  };
}

export async function listPromotions(
  filters: repo.PromotionListFilters,
  limit: number,
  offset: number,
): Promise<{ items: WirePromotion[]; total: number }> {
  const { rows, total } = await repo.findPromotions(filters, limit, offset);
  const promos = await hydrate(rows);
  const now = new Date();
  const labels = await Promise.all(rows.map((r) => repo.findTargetLabel(r)));
  return { items: rows.map((r, i) => wire(r, promos[i]!, labels[i] ?? null, now)), total };
}

export async function getPromotion(id: number): Promise<WirePromotion> {
  const row = await repo.findPromotionById(id);
  if (!row) throw new NotFoundError('Promotion not found');
  const [promo] = await hydrate([row]);
  const label = await repo.findTargetLabel(row);
  return wire(row, promo!, label, new Date());
}

// ── الكتابة ─────────────────────────────────────────────────────────────────

export interface PromotionInput {
  name_ar: string;
  name_en?: string | null;
  scope: PromotionRow['scope'];
  branch_ids?: number[];
  target_kind: PromotionRow['target_kind'];
  target_id: number;
  kind: PromotionRow['kind'];
  percent_value?: number | null;
  amount_syp?: number | null;
  buy_qty?: number | null;
  get_qty?: number | null;
  get_percent?: number | null;
  tiers?: { min_qty: number; percent_value?: number | null; amount_syp?: number | null }[];
  starts_at?: string | null;
  ends_at?: string | null;
  channel: PromotionRow['channel'];
  segment: PromotionRow['segment'];
  is_stackable: boolean;
  is_active: boolean;
}

/**
 * ما يُرجَع مع العرض المحفوظ: العرض نفسه **والأصناف التي يبيعها تحت التكلفة**.
 *
 * التحذير يسافر مع الردّ لا بنداء ثانٍ: نداءٌ ثانٍ يمكن ألّا يُرسَل، وعندها
 * يُحفظ العرض بلا أن يرى أحد ما فعله.
 */
export interface PromotionSaveResult {
  promotion: WirePromotion;
  loss_warnings: { variant_id: number; name_ar: string; price_syp: number; avg_cost_syp: number }[];
}

function validateShape(input: PromotionInput): void {
  const pct = input.percent_value ?? null;
  const amount = input.amount_syp ?? null;
  const tiers = input.tiers ?? [];
  switch (input.kind) {
    case 'percent':
      if (pct === null || pct <= 0 || pct > 100)
        throw new BusinessError(422, 'A percentage promotion needs a percent between 0 and 100', 'promotion_percent_required');
      break;
    case 'amount':
      if (amount === null || amount <= 0)
        throw new BusinessError(422, 'An amount promotion needs an amount above zero', 'promotion_amount_required');
      break;
    case 'qty_tiers':
      if (tiers.length === 0)
        throw new BusinessError(422, 'A tiered promotion needs at least one tier', 'promotion_tiers_required');
      for (const t of tiers) {
        if (t.min_qty <= 0)
          throw new BusinessError(422, 'A tier starts at a quantity above zero', 'promotion_tier_qty_invalid');
        const hasPct = t.percent_value !== null && t.percent_value !== undefined;
        const hasAmount = t.amount_syp !== null && t.amount_syp !== undefined;
        // شريحةٌ بالاثنين تجعل «كم الخصم؟» سؤالاً بجوابين، وبلا أيٍّ منهما تُحفظ
        // ولا تخصم شيئاً — وكلتاهما تُقرأ بالقائمة شريحةً عاملة.
        if (hasPct === hasAmount)
          throw new BusinessError(422, 'A tier carries either a percent or an amount', 'promotion_tier_value_invalid');
      }
      break;
    case 'buy_x_get_y':
      if ((input.buy_qty ?? 0) <= 0 || (input.get_qty ?? 0) <= 0)
        throw new BusinessError(422, 'Buy X get Y needs both quantities above zero', 'promotion_bxgy_required');
      break;
  }
  if (input.scope === 'branches' && (input.branch_ids ?? []).length === 0)
    throw new BusinessError(422, 'A branch-scoped promotion needs at least one branch', 'promotion_branches_required');
}

/**
 * السقف يُفحص **بعد** التحقّق من الشكل وقبل الحفظ.
 *
 * ويُقاس بأعلى ما يفعله العرض (`maxPercentOf`) لا بحالته الشائعة: سقفٌ يُقاس
 * بأقلّ ما يفعله يُتجاوز بالكمية الكبيرة وحدها، وتلك أكبر الفواتير.
 */
async function enforceCap(promo: Promotion): Promise<void> {
  if (!capApplies(promo)) return;
  const caps = new Map((await repo.findCaps()).map((c) => [c.branch_id, Number(c.max_discount_percent)]));
  const reach = maxPercentOf(promo, 100);
  for (const branchId of promo.branchIds ?? []) {
    const cap = caps.get(branchId) ?? DEFAULT_BRANCH_CAP_PERCENT;
    if (reach > cap + 1e-9) {
      throw new BusinessError(
        409,
        `This promotion discounts ${reach}% — above the ${cap}% this branch may give`,
        'promotion_above_branch_cap',
        { branch_id: branchId, cap_percent: cap, promotion_percent: reach },
      );
    }
  }
}

/** ما الذي يبيعه هذا العرض تحت تكلفته — تحذيرٌ لا منع (§٥). */
async function lossWarningsFor_(
  row: PromotionRow,
  promo: Promotion,
): Promise<PromotionSaveResult['loss_warnings']> {
  const targets = await repo.findVariantsForTarget(row);
  if (targets.length === 0) return [];
  const branchId = promo.branchIds?.[0] ?? null;
  const variantIds = targets.map((t) => t.variant_id);
  const [prices, costs] = await Promise.all([
    // السعر يُقاس بفرع العرض إن كان فرعياً، وإلا بأي فرع حيّ — السعر المركزي
    // هو ما يراه الجميع، وقياسه بفرعٍ بعينه يخطئ حين يملك الفرع استثناءً.
    branchId === null ? centralPrices(variantIds) : resolvePricesAt(branchId, variantIds, BASE_PRICES),
    resolveAvgCostAt(branchId, variantIds),
  ]);
  const rows = targets
    .map((t) => {
      const price = prices.get(t.variant_id);
      if (!price || price.status !== 'priced' || price.amountSyp === null) return null;
      const after = resolveLine(
        [promo],
        {
          variantId: t.variant_id,
          productId: t.product_id,
          categoryPath: [],
          brandId: null,
          basePriceSyp: price.amountSyp,
          // أكبر شريحة: الخصم الأعمق هو ما يجب أن يُحذَّر منه.
          qty: Math.max(1, ...promo.tiers.map((x) => x.minQty)),
        },
        {
          branchId: branchId ?? 0,
          channel: promo.channel === 'pos' ? 'pos' : 'online',
          segment: promo.segment === 'wholesale' ? 'wholesale' : 'retail',
          now: new Date(),
        },
      );
      return {
        variantId: t.variant_id,
        name_ar: t.name_ar,
        priceAfterSyp: after.unitAfterSyp,
        avgCostSyp: costs.get(t.variant_id) ?? null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const nameBy = new Map(rows.map((r) => [r.variantId, r.name_ar]));
  return lossWarningsFor(rows).map((w) => ({
    variant_id: w.variantId,
    name_ar: nameBy.get(w.variantId) ?? '',
    price_syp: Math.round(w.priceSyp),
    avg_cost_syp: Math.round(w.avgCostSyp),
  }));
}

/** سعر العرض المركزي: أول فرع حيّ يكفي — السعر المركزي واحدٌ لكل الفروع بحكم التعريف. */
async function centralPrices(variantIds: number[]) {
  const branches = await repo.findLiveBranches();
  const first = branches[0];
  if (!first) return new Map();
  return resolvePricesAt(first.id, variantIds, BASE_PRICES);
}

function columnsOf(input: PromotionInput) {
  const target = {
    variant_id: input.target_kind === 'variant' ? input.target_id : null,
    product_id: input.target_kind === 'product' ? input.target_id : null,
    category_id: input.target_kind === 'category' ? input.target_id : null,
    brand_id: input.target_kind === 'brand' ? input.target_id : null,
  };
  const str = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));
  return {
    ...target,
    name_ar: input.name_ar,
    name_en: input.name_en ?? null,
    scope: input.scope,
    target_kind: input.target_kind,
    kind: input.kind,
    percent_value: str(input.percent_value),
    amount_syp: str(input.amount_syp),
    buy_qty: input.buy_qty ?? null,
    get_qty: input.get_qty ?? null,
    get_percent: str(input.get_percent),
    starts_at: input.starts_at ? new Date(input.starts_at) : null,
    ends_at: input.ends_at ? new Date(input.ends_at) : null,
    channel: input.channel,
    segment: input.segment,
    is_stackable: input.is_stackable,
    is_active: input.is_active,
  };
}

function tierColumns(input: PromotionInput) {
  return (input.tiers ?? []).map((t) => ({
    min_qty: t.min_qty,
    percent_value: t.percent_value === null || t.percent_value === undefined ? null : String(t.percent_value),
    amount_syp: t.amount_syp === null || t.amount_syp === undefined ? null : String(t.amount_syp),
  }));
}

export async function createPromotion(
  actor: RequestActorContext,
  input: PromotionInput,
): Promise<PromotionSaveResult> {
  validateShape(input);
  const row = await repo.insertPromotion({ ...columnsOf(input), created_by: actor.userId });
  await repo.replaceBranchLinks(row.id, input.scope === 'branches' ? (input.branch_ids ?? []) : []);
  await repo.replaceTiers(row.id, tierColumns(input));

  const [promo] = await hydrate([row]);
  try {
    await enforceCap(promo!);
  } catch (error) {
    // السقف يُرفض **بعد** الحفظ لأن الفروع والشرائح صفوفٌ منفصلة لا تُقاس قبل
    // كتابتها — فيُمحى الصفّ كاملاً، ولا يبقى عرضٌ مرفوضٌ ظاهرٌ بالقائمة.
    await repo.deletePromotion(row.id);
    throw error;
  }

  await recordAudit(actor, PROMOTION_AUDIT.create, promotionTarget.one(row.id), null, columnsOf(input));
  const label = await repo.findTargetLabel(row);
  return {
    promotion: wire(row, promo!, label, new Date()),
    loss_warnings: await lossWarningsFor_(row, promo!),
  };
}

export async function updatePromotionById(
  actor: RequestActorContext,
  id: number,
  input: PromotionInput,
): Promise<PromotionSaveResult> {
  const before = await repo.findPromotionById(id);
  if (!before) throw new NotFoundError('Promotion not found');
  if (before.archived_at !== null)
    throw new BusinessError(409, 'This promotion is archived', 'promotion_archived');
  validateShape(input);

  const row = await repo.updatePromotion(id, columnsOf(input));
  if (!row) throw new NotFoundError('Promotion not found');
  await repo.replaceBranchLinks(id, input.scope === 'branches' ? (input.branch_ids ?? []) : []);
  await repo.replaceTiers(id, tierColumns(input));

  const [promo] = await hydrate([row]);
  await enforceCap(promo!);
  await recordAudit(actor, PROMOTION_AUDIT.update, promotionTarget.one(id), before, columnsOf(input));
  const label = await repo.findTargetLabel(row);
  return {
    promotion: wire(row, promo!, label, new Date()),
    loss_warnings: await lossWarningsFor_(row, promo!),
  };
}

export async function archivePromotion(
  actor: RequestActorContext,
  id: number,
  archived: boolean,
): Promise<WirePromotion> {
  const before = await repo.findPromotionById(id);
  if (!before) throw new NotFoundError('Promotion not found');
  const row = await repo.updatePromotion(id, { archived_at: archived ? new Date() : null });
  await recordAudit(
    actor,
    archived ? PROMOTION_AUDIT.archive : PROMOTION_AUDIT.unarchive,
    promotionTarget.one(id),
    { archived_at: before.archived_at },
    { archived_at: row?.archived_at ?? null },
  );
  return getPromotion(id);
}

export async function removePromotion(actor: RequestActorContext, id: number): Promise<void> {
  const before = await repo.findPromotionById(id);
  if (!before) throw new NotFoundError('Promotion not found');
  await repo.deletePromotion(id);
  await recordAudit(actor, PROMOTION_AUDIT.delete, promotionTarget.one(id), before, null);
}

// ── السقوف ──────────────────────────────────────────────────────────────────

export interface WireCaps {
  default_percent: number;
  branches: { id: number; name_ar: string; max_discount_percent: number; is_default: boolean }[];
}

export async function getCaps(): Promise<WireCaps> {
  const [branches, caps] = await Promise.all([repo.findLiveBranches(), repo.findCaps()]);
  const by = new Map(caps.map((c) => [c.branch_id, Number(c.max_discount_percent)]));
  return {
    default_percent: DEFAULT_BRANCH_CAP_PERCENT,
    branches: branches.map((b) => ({
      id: b.id,
      name_ar: b.name_ar,
      max_discount_percent: by.get(b.id) ?? DEFAULT_BRANCH_CAP_PERCENT,
      // «١٥٪» المكتوبة تختلف عن «١٥٪» الموروثة: الأولى قرارٌ والثانية غيابه.
      is_default: !by.has(b.id),
    })),
  };
}

export async function setCap(
  actor: RequestActorContext,
  branchId: number,
  percent: number,
): Promise<WireCaps> {
  const before = await repo.findCaps();
  await repo.upsertCap(branchId, String(percent), actor.userId);
  await recordAudit(
    actor,
    PROMOTION_AUDIT.capSet,
    promotionTarget.caps(),
    before.find((c) => c.branch_id === branchId) ?? null,
    { branch_id: branchId, max_discount_percent: percent },
  );
  return getCaps();
}

// ── المعاينة: سلّة افتراضية تُجرَّب قبل النشر ────────────────────────────────

export interface PreviewInput {
  branch_id: number;
  channel: 'online' | 'pos';
  segment: 'retail' | 'wholesale';
  lines: { variant_id: number; qty: number }[];
}

export interface WirePreviewLine {
  variant_id: number;
  qty: number;
  unit_before_syp: number;
  unit_after_syp: number;
  applied: { promotion_id: number; name_ar: string; unit_discount_syp: number }[];
  free: { promotion_id: number; name_ar: string; qty: number; discount_syp: number } | null;
  line_total_syp: number;
  /** التكلفة على هذا الفرع — `null` = لم يُستلم قط، فلا حكم بالخسارة. */
  avg_cost_syp: number | null;
  below_cost: boolean;
}

/**
 * **المستدعي الحيّ لمحرّك السلّة.** «اشترِ ٣ خذ ١» لا يظهر بسعر بندٍ ولا
 * بصفحة منتج، فبلا هذا المسار كان يُحفظ ولا يراه أحد يعمل حتى تُبنى السلّة —
 * وهو بالضبط «المبنيّ بلا مستهلك» الذي يحذّر منه `CLAUDE.md`.
 *
 * وهو نفسه ما تستدعيه السلّة يوم تُبنى: دالّةٌ واحدة تُسعّر سلّة، لا نسخة
 * للمعاينة وأخرى للبيع.
 */
export async function previewBasket(input: PreviewInput): Promise<{
  lines: WirePreviewLine[];
  total_before_syp: number;
  total_after_syp: number;
}> {
  const variantIds = input.lines.map((l) => l.variant_id);
  const [prices, costs, candidates, paths, targets] = await Promise.all([
    resolvePricesAt(input.branch_id, variantIds, BASE_PRICES),
    resolveAvgCostAt(input.branch_id, variantIds),
    hydrate(await repo.findCandidates()),
    categoryPaths(),
    repo.findVariantContext(variantIds),
  ]);
  const ctxOf = new Map(targets.map((t) => [t.variant_id, t]));

  const items: PromotionItem[] = [];
  for (const line of input.lines) {
    const price = prices.get(line.variant_id);
    const meta = ctxOf.get(line.variant_id);
    if (!price || !meta) continue;
    const wholesale = input.segment === 'wholesale' ? price.wholesale : null;
    const base =
      wholesale !== null && line.qty >= wholesale.minQty ? wholesale.amountSyp : price.amountSyp;
    if (price.status !== 'priced' || base === null) continue;
    items.push({
      variantId: line.variant_id,
      productId: meta.product_id,
      categoryPath: meta.category_id === null ? [] : (paths.get(meta.category_id) ?? []),
      brandId: meta.brand_id,
      basePriceSyp: base,
      qty: line.qty,
    });
  }

  const basket = applyBasket(candidates, items, {
    branchId: input.branch_id,
    channel: input.channel,
    segment: input.segment,
    now: new Date(),
  });

  const lines = basket.map((b): WirePreviewLine => {
    const cost = costs.get(b.item.variantId) ?? null;
    return {
      variant_id: b.item.variantId,
      qty: b.item.qty,
      unit_before_syp: Math.round(b.line.unitBeforeSyp),
      unit_after_syp: Math.round(b.line.unitAfterSyp),
      applied: b.line.applied.map((a) => ({
        promotion_id: a.promotionId,
        name_ar: a.nameAr,
        unit_discount_syp: Math.round(a.unitDiscountSyp),
      })),
      free: b.free
        ? {
            promotion_id: b.free.promotionId,
            name_ar: b.free.nameAr,
            qty: b.free.qty,
            discount_syp: Math.round(b.free.discountSyp),
          }
        : null,
      line_total_syp: Math.round(b.lineTotalSyp),
      avg_cost_syp: cost === null ? null : Math.round(cost),
      below_cost: cost !== null && cost > 0 && b.line.unitAfterSyp < cost,
    };
  });

  return {
    lines,
    total_before_syp: basket.reduce((sum, b) => sum + b.line.unitBeforeSyp * b.item.qty, 0),
    total_after_syp: lines.reduce((sum, l) => sum + l.line_total_syp, 0),
  };
}

// ── الإشارة ─────────────────────────────────────────────────────────────────

/**
 * ما يجب أن تراه الإدارة بلا أن تفتح كل عرض: العروض السارية الآن، وما ينتهي
 * خلال أسبوع، وما **بلا نهاية** (العرض المنسيّ هو الذي يبيع بخسارة شهوراً).
 */
export async function getSignals(): Promise<{
  live: number;
  ending_soon: number;
  never_ending: number;
  scheduled: number;
}> {
  const promos = await hydrate(await repo.findCandidates());
  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  let live = 0;
  let endingSoon = 0;
  let neverEnding = 0;
  let scheduled = 0;
  for (const p of promos) {
    const status = statusOf(p, now);
    if (status === 'scheduled') scheduled += 1;
    if (status !== 'live') continue;
    live += 1;
    if (p.endsAt === null) neverEnding += 1;
    else if (p.endsAt <= weekOut) endingSoon += 1;
  }
  return { live, ending_soon: endingSoon, never_ending: neverEnding, scheduled };
}
