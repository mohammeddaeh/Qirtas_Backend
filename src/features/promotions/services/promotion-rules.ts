/**
 * أي عرض ينطبق، وبكم — دالّات صافية، `store_system.md` §٥.
 *
 * **كل جواب خاطئ هنا رقمٌ معقول على الرفّ.** لا استثناء ولا سجل: العرض ينطبق
 * حيث لا يجب فتُباع البضاعة بخسارة، أو لا ينطبق حيث يجب فيدفع الزبون سعراً
 * أعلى من المُعلَن على الواجهة. لذلك المنطق كلّه هنا، صافياً ومُختبَراً، ولا
 * شيء منه يُكرَّر بالعميل.
 */

export type PromotionKind = 'percent' | 'amount' | 'buy_x_get_y' | 'qty_tiers';
export type PromotionChannel = 'online' | 'pos' | 'both';
export type PromotionSegment = 'retail' | 'wholesale' | 'all';

export interface PromotionTier {
  minQty: number;
  percent: number | null;
  amountSyp: number | null;
}

export interface Promotion {
  id: number;
  nameAr: string;
  kind: PromotionKind;
  /** هدفٌ واحد بالضبط — يفرضه قيد `promotion_one_target` بالجدول. */
  target:
    | { kind: 'variant'; id: number }
    | { kind: 'product'; id: number }
    | { kind: 'category'; id: number }
    | { kind: 'brand'; id: number };
  /** `null` = كل الفروع. قائمةٌ فارغة = لا فرع، فلا ينطبق على أحد. */
  branchIds: number[] | null;
  percent: number | null;
  amountSyp: number | null;
  buyQty: number | null;
  getQty: number | null;
  getPercent: number | null;
  tiers: PromotionTier[];
  startsAt: Date | null;
  endsAt: Date | null;
  channel: PromotionChannel;
  segment: PromotionSegment;
  isStackable: boolean;
  isActive: boolean;
  archivedAt: Date | null;
}

export interface PromotionContext {
  branchId: number;
  channel: 'online' | 'pos';
  segment: 'retail' | 'wholesale';
  now: Date;
}

export interface PromotionItem {
  variantId: number;
  productId: number;
  /**
   * التصنيف وكل آبائه حتى الجذر. عرضٌ على «القرطاسية» يشمل «الأقلام» تحتها —
   * والوراثة **تنزل** كما ترث الأسعار والسياسات (§٣). بلا المسار كان العرض
   * يحتاج صفّاً لكل تصنيف فرعي، فيُنسى واحدٌ منها ولا شيء يقول ذلك.
   */
  categoryPath: number[];
  brandId: number | null;
  /** السعر الذي يدفعه هذا المشتري قبل أي عرض (تجزئةً كان أو جملة). */
  basePriceSyp: number;
  qty: number;
}

/** حالة العرض كما تُقرأ بالقائمة — الأربع مختلفة الجواب، ولا تُجمع بـ«مفعّل». */
export type PromotionStatus = 'live' | 'scheduled' | 'ended' | 'inactive' | 'archived';

export const DEFAULT_BRANCH_CAP_PERCENT = 20;

export function statusOf(p: Promotion, now: Date): PromotionStatus {
  if (p.archivedAt !== null) return 'archived';
  if (!p.isActive) return 'inactive';
  if (p.startsAt !== null && now < p.startsAt) return 'scheduled';
  // `endsAt` لحظة التوقّف لا آخر لحظة سريان — الثانية التي قبلها ما زالت عرضاً.
  if (p.endsAt !== null && now >= p.endsAt) return 'ended';
  return 'live';
}

/**
 * هل هذا العرض ساري المفعول **هنا والآن ولهذا المشتري**.
 *
 * الشروط الخمسة تُفحص معاً لأن سقوط أيٍّ منها يُنتج نفس العطل الصامت: عرضُ
 * فرع المزة يُطبَّق بحلب، أو عرض الجملة يُعطى لزبون تجزئة، أو عرض الكاشير
 * يظهر بالمتجر.
 */
export function isLive(p: Promotion, ctx: PromotionContext): boolean {
  if (statusOf(p, ctx.now) !== 'live') return false;
  if (p.channel !== 'both' && p.channel !== ctx.channel) return false;
  if (p.segment !== 'all' && p.segment !== ctx.segment) return false;
  if (p.branchIds !== null && !p.branchIds.includes(ctx.branchId)) return false;
  return true;
}

/** هل يمسّ هذا العرض هذا الصنف — بالمتغيّر أو منتجه أو تصنيفه (وآبائه) أو ماركته. */
export function appliesTo(p: Promotion, item: PromotionItem): boolean {
  switch (p.target.kind) {
    case 'variant':
      return p.target.id === item.variantId;
    case 'product':
      return p.target.id === item.productId;
    case 'category':
      return item.categoryPath.includes(p.target.id);
    case 'brand':
      return item.brandId !== null && p.target.id === item.brandId;
  }
}

/** أدقّ هدفٍ أولاً. يُستعمل للعرض وللترجيح حين يتساوى الخصمان تماماً. */
export function targetSpecificity(p: Promotion): number {
  switch (p.target.kind) {
    case 'variant':
      return 4;
    case 'product':
      return 3;
    case 'brand':
      return 2;
    case 'category':
      return 1;
  }
}

/** الشريحة المنطبقة: أكبر `min_qty` لا تتجاوز الكمية. ولا شيء تحت أصغر شريحة. */
export function tierFor(tiers: PromotionTier[], qty: number): PromotionTier | null {
  let best: PromotionTier | null = null;
  for (const t of tiers) {
    if (t.minQty <= qty && (best === null || t.minQty > best.minQty)) best = t;
  }
  return best;
}

/**
 * ما يُحسم من **سعر الوحدة** بهذا العرض.
 *
 * مسقوفٌ بالسعر نفسه: مبلغُ حسمٍ أكبر من السعر يعني سعراً سالباً — أي متجراً
 * يدفع لمن يأخذ بضاعته، وهو رقمٌ يمرّ بكل جمعٍ وطرحٍ بعده بلا اعتراض.
 *
 * و`buy_x_get_y` تُرجع صفراً هنا **عمداً**: قرارها على السلّة لا على سعر
 * البند، وحسابُها بسعر الوحدة كان سيعرض «٢٥٪ خصم» على صفحة منتجٍ يشتري منه
 * الزبون واحداً فلا يأخذ شيئاً.
 */
export function unitDiscountOf(p: Promotion, item: PromotionItem): number {
  const base = item.basePriceSyp;
  if (base <= 0) return 0;
  const cap = (value: number) => Math.max(0, Math.min(value, base));
  switch (p.kind) {
    case 'percent':
      return p.percent === null ? 0 : cap((base * p.percent) / 100);
    case 'amount':
      return p.amountSyp === null ? 0 : cap(p.amountSyp);
    case 'qty_tiers': {
      const tier = tierFor(p.tiers, item.qty);
      if (tier === null) return 0;
      if (tier.percent !== null) return cap((base * tier.percent) / 100);
      if (tier.amountSyp !== null) return cap(tier.amountSyp);
      return 0;
    }
    case 'buy_x_get_y':
      return 0;
  }
}

export interface AppliedPromotion {
  promotionId: number;
  nameAr: string;
  kind: PromotionKind;
  /** ما حسمه هذا العرض من سعر الوحدة بعد ما سبقه — لا نسبته الاسمية. */
  unitDiscountSyp: number;
}

export interface LineOutcome {
  unitBeforeSyp: number;
  unitAfterSyp: number;
  applied: AppliedPromotion[];
}

/**
 * **الأفضل للزبون** (§٥) — وما يتراكم يتراكم فوقه.
 *
 * غير القابل للتراكم: يُختار **واحد**، الأكبر خصماً. جمعُ عرضين لم يُعلَن
 * تراكمهما هو كيف يصير الصنف مجانياً بلا أن يقصد ذلك أحد.
 *
 * والقابل للتراكم يُطبَّق **متتابعاً على المتبقّي** لا بجمع النسب: خصمان ٥٠٪
 * يعطيان ٧٥٪ لا ١٠٠٪. جمعُ النسب يجعل ثلاثة عروض معقولة بضاعةً مجانية، وذلك
 * لا يظهر إلا بالفاتورة.
 *
 * الترتيب ثابت: الأكبر خصماً أولاً، ثم الأدقّ هدفاً، ثم الأقدم — فالجواب نفسه
 * لا يتغيّر بترتيب وصول الصفوف من قاعدة البيانات.
 */
export function resolveLine(
  promotions: Promotion[],
  item: PromotionItem,
  ctx: PromotionContext,
): LineOutcome {
  const base = item.basePriceSyp;
  const candidates = promotions
    .filter((p) => isLive(p, ctx) && appliesTo(p, item))
    .map((p) => ({ p, discount: unitDiscountOf(p, item) }))
    .filter((c) => c.discount > 0)
    .sort(
      (a, b) =>
        b.discount - a.discount ||
        targetSpecificity(b.p) - targetSpecificity(a.p) ||
        a.p.id - b.p.id,
    );

  const applied: AppliedPromotion[] = [];
  let remaining = base;

  const bestExclusive = candidates.find((c) => !c.p.isStackable);
  if (bestExclusive) {
    const taken = Math.min(bestExclusive.discount, remaining);
    remaining -= taken;
    applied.push({
      promotionId: bestExclusive.p.id,
      nameAr: bestExclusive.p.nameAr,
      kind: bestExclusive.p.kind,
      unitDiscountSyp: taken,
    });
  }

  for (const c of candidates) {
    if (!c.p.isStackable || remaining <= 0) continue;
    // نسبة العرض تُعاد على المتبقّي؛ والمبلغ الثابت يبقى مبلغاً.
    const share = c.p.kind === 'amount' ? c.discount : (remaining * c.discount) / base;
    const taken = Math.min(share, remaining);
    if (taken <= 0) continue;
    remaining -= taken;
    applied.push({
      promotionId: c.p.id,
      nameAr: c.p.nameAr,
      kind: c.p.kind,
      unitDiscountSyp: taken,
    });
  }

  return {
    unitBeforeSyp: base,
    unitAfterSyp: Math.max(0, remaining),
    applied,
  };
}

export interface FreeUnits {
  promotionId: number;
  nameAr: string;
  /** عدد الوحدات المجانية (أو المخفَّضة بـ`getPercent`). */
  qty: number;
  /** ما يُحسم من إجمالي السطر مقابلها. */
  discountSyp: number;
}

/**
 * «اشترِ ٣ خذ ١» — قرارٌ على السلّة.
 *
 * المجموعة = `buyQty + getQty`، وعدد المجاني = `floor(qty / group) × getQty`.
 * القراءة الأخرى («اشترِ ٣ فتأتيك الرابعة مع الثلاث») تُعطي الهدية لمن اشترى
 * ثلاثاً ولم يأخذ رابعة — أي تُحاسبه على اثنتين، وهو ليس ما وعد به الإعلان.
 *
 * **والهدية من الصنف نفسه**: «اشترِ قلماً خذ دفتراً» هدفان بصفّ واحد، وذلك
 * ما يمنعه `promotion_one_target`. يُبنى مع السلّة (المرحلة ٧) إن طُلب.
 */
export function freeUnitsOf(p: Promotion, item: PromotionItem): FreeUnits | null {
  if (p.kind !== 'buy_x_get_y') return null;
  const buy = p.buyQty ?? 0;
  const get = p.getQty ?? 0;
  if (buy <= 0 || get <= 0) return null;
  const group = buy + get;
  const groups = Math.floor(item.qty / group);
  if (groups <= 0) return null;
  const qty = groups * get;
  const percent = p.getPercent ?? 100;
  const discount = (item.basePriceSyp * qty * Math.max(0, Math.min(100, percent))) / 100;
  if (discount <= 0) return null;
  return { promotionId: p.id, nameAr: p.nameAr, qty, discountSyp: discount };
}

export interface BasketLine {
  item: PromotionItem;
  line: LineOutcome;
  free: FreeUnits | null;
  /** ما يدفعه هذا السطر فعلاً: (بعد الخصم × الكمية) ناقص قيمة الهدايا. */
  lineTotalSyp: number;
}

/**
 * السلّة كاملةً: خصم البند أولاً، ثم الهدايا **على السعر بعد الخصم**.
 *
 * على السعر قبل الخصم كانت الهدية تساوي أكثر من الوحدة المدفوعة، فيُنتج سطرٌ
 * مجموعُه سالب — وذلك يُجمع بالفاتورة بلا اعتراض.
 */
export function applyBasket(
  promotions: Promotion[],
  items: PromotionItem[],
  ctx: PromotionContext,
): BasketLine[] {
  return items.map((item) => {
    const line = resolveLine(promotions, item, ctx);
    const gifts = promotions
      .filter((p) => p.kind === 'buy_x_get_y' && isLive(p, ctx) && appliesTo(p, item))
      .map((p) => freeUnitsOf(p, { ...item, basePriceSyp: line.unitAfterSyp }))
      .filter((f): f is FreeUnits => f !== null)
      // هديةٌ واحدة لكل سطر: الأفضل للزبون. تراكمها يُخرج أكثر مما بالسلّة.
      .sort((a, b) => b.discountSyp - a.discountSyp || a.promotionId - b.promotionId);
    const free = gifts[0] ?? null;
    const gross = line.unitAfterSyp * item.qty;
    const total = Math.max(0, gross - (free?.discountSyp ?? 0));
    return { item, line, free, lineTotalSyp: total };
  });
}

// ── السقف وحارس الخسارة ─────────────────────────────────────────────────────

/**
 * أقصى نسبة يصل إليها هذا العرض على سعر وحدةٍ مفترض — به يُقاس السقف.
 *
 * تُحسب من **أعلى** شريحة وأعلى هدية، لا من الحالة الشائعة: سقفٌ يُقاس بأقلّ
 * ما يفعله العرض هو سقفٌ يُتجاوز بالكمية الكبيرة وحدها، وتلك أكبر الفواتير.
 */
export function maxPercentOf(p: Promotion, unitPriceSyp: number): number {
  if (unitPriceSyp <= 0) return 0;
  const pct = (value: number) => Math.max(0, Math.min(100, (value / unitPriceSyp) * 100));
  switch (p.kind) {
    case 'percent':
      return Math.max(0, Math.min(100, p.percent ?? 0));
    case 'amount':
      return pct(p.amountSyp ?? 0);
    case 'qty_tiers': {
      let worst = 0;
      for (const t of p.tiers) {
        const value =
          t.percent !== null ? Math.max(0, Math.min(100, t.percent)) : pct(t.amountSyp ?? 0);
        if (value > worst) worst = value;
      }
      return worst;
    }
    case 'buy_x_get_y': {
      const buy = p.buyQty ?? 0;
      const get = p.getQty ?? 0;
      if (buy <= 0 || get <= 0) return 0;
      // «اشترِ ٣ خذ ١ مجاناً» = ٢٥٪ على المجموعة.
      const percent = Math.max(0, Math.min(100, p.getPercent ?? 100));
      return ((get * percent) / (buy + get)) * 1;
    }
  }
}

/**
 * سقف الفرع يقيّد العرض **الفرعي وحده** (قرار 2026-09-23).
 *
 * الإدارة التي تحدّد السقف لا تُحَدّ به، وإلا احتاج كل عرض مركزي رفعَ السقف
 * ثم إعادته — وتلك دقيقةٌ يبقى فيها السقف مرفوعاً لكل الفروع.
 */
export function capApplies(p: Pick<Promotion, 'branchIds'>): boolean {
  return p.branchIds !== null;
}

export interface LossWarning {
  variantId: number;
  /** السعر بعد العرض، والتكلفة التي نزل تحتها. */
  priceSyp: number;
  avgCostSyp: number;
}

/**
 * **حارس الخسارة** (§٥): تحذيرٌ لا منع (قرار 2026-09-23).
 *
 * البيع بخسارة قرارٌ تجاري مشروع — تصريف بضاعة راكدة، أو صنفٌ يجرّ غيره.
 * والمنعُ يُلتَفّ عليه بتعديل السعر المركزي، وهناك يختفي الأثر تماماً: لا عرض
 * ولا تحذير ولا إشارة، سعرٌ منخفض فحسب.
 *
 * التكلفة الغائبة **ليست صفراً**: صنفٌ لم يُستلم قط لا تكلفة له، ومقارنته بصفر
 * تجعل كل عرض عليه خسارة — ولوحةٌ تحذّر دائماً لا يقرؤها أحد.
 */
export function lossWarningsFor(
  priced: { variantId: number; priceAfterSyp: number; avgCostSyp: number | null }[],
): LossWarning[] {
  const out: LossWarning[] = [];
  for (const row of priced) {
    if (row.avgCostSyp === null || row.avgCostSyp <= 0) continue;
    if (row.priceAfterSyp >= row.avgCostSyp) continue;
    out.push({
      variantId: row.variantId,
      priceSyp: row.priceAfterSyp,
      avgCostSyp: row.avgCostSyp,
    });
  }
  return out;
}
