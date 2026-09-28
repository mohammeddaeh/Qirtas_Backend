import type { ConsumptionBasis } from '../schemas/print-consumption.schema.js';

/**
 * قواعد وصفة الاستهلاك — دالّات صافية (`printing_system.md` §خطة 9-هـ).
 *
 * **كل خطأ هنا صامت**: وصفةٌ تُضرب بالصفحات بدل الأوراق تُخصم ضعف الورق،
 * وكسرٌ يُقرَّب لصفر يُخفي الحبر كله، وتسويةٌ بإشارة معكوسة تُضاعف الفرق بدل
 * أن تُصلحه — والمخزون والربح يُعرضان سليمين.
 */

export interface ConsumptionRule {
  optionId: number;
  variantId: number;
  basis: ConsumptionBasis;
  qty: number | null;
  yieldPages: number | null;
}

/** ما يُقاس به الطلب — من تسعير الخادم نفسه (`quote`)، لا من العميل. */
export interface JobMeasure {
  sheets: number;
  printedPages: number;
  copies: number;
}

/** كم مرةً ينطبق الأساس على هذا الطلب. */
export function basisCount(basis: ConsumptionBasis, m: JobMeasure): number {
  switch (basis) {
    case 'per_sheet':
      return m.sheets;
    case 'per_printed_page':
      return m.printedPages;
    case 'per_copy':
      return m.copies;
    case 'per_job':
      return 1;
  }
}

/** استهلاك وحدة الأساس الواحدة: الكمية، أو ١/المردود للحبر. */
export function perUnit(rule: ConsumptionRule): number {
  if (rule.qty !== null) return rule.qty;
  if (rule.yieldPages !== null && rule.yieldPages > 0) return 1 / rule.yieldPages;
  return 0;
}

export interface ConsumedMaterial {
  variantId: number;
  /** بالدقة الكاملة — لا يُقرَّب هنا (التقريب عند الترحيل وحده). */
  qty: number;
  /** الصفحات التي تُحسب على مردود هذه المادة (للمواد بالمردود وحدها). */
  yieldPages: number;
}

/**
 * ما يستهلكه طلبٌ بمواصفته — قواعد خياراته الخمسة وحدها، **مجموعةً بالمادة**:
 * خياران يستهلكان المادة نفسها (الأبيض والأسود والملوّن كلاهما يستهلك الأسود)
 * سطرٌ واحد لا سطران يُخصمان مرتين بلا أن يُرى.
 */
export function consumptionFor(
  optionIds: number[],
  rules: ConsumptionRule[],
  m: JobMeasure,
): ConsumedMaterial[] {
  const chosen = new Set(optionIds);
  const byVariant = new Map<number, ConsumedMaterial>();
  for (const rule of rules) {
    if (!chosen.has(rule.optionId)) continue;
    const count = basisCount(rule.basis, m);
    const qty = perUnit(rule) * count;
    if (!(qty > 0)) continue;
    const current = byVariant.get(rule.variantId) ?? {
      variantId: rule.variantId,
      qty: 0,
      yieldPages: 0,
    };
    current.qty = round9(current.qty + qty);
    if (rule.yieldPages !== null) current.yieldPages += count;
    byVariant.set(rule.variantId, current);
  }
  return [...byVariant.values()];
}

/** خطوة المخزون: ثلاث خانات عشرية (`qty_base` scale 3). */
export const STOCK_STEP = 0.001;

/**
 * ما يُرحَّل للمخزون الآن من كسورٍ متجمّعة — **المضاعف الكامل لخطوة المخزون**
 * وحده، والباقي ينتظر. تقريبٌ لأقرب خطوة كان سيخصم ما لم يُستهلك بعد، أو
 * يُسقط الحبر كله لطلبات الصفحة الواحدة.
 */
export function splitPostable(pending: number): { post: number; remaining: number } {
  if (!(pending > 0)) return { post: 0, remaining: round9(Math.max(0, pending)) };
  // الإبسلون: ٠٫٠٠٣ عشري يُخزَّن ٠٫٠٠٢٩٩٩… فيُرحَّل ٠٫٠٠٢ بلا الإبسلون.
  const steps = Math.floor(pending / STOCK_STEP + 1e-6);
  const post = round3(steps * STOCK_STEP);
  return { post, remaining: round9(Math.max(0, pending - post)) };
}

export interface ReconcileInput {
  /** المقدَّر منذ آخر تركيب — مرحَّلاً ومعلَّقاً. */
  sinceInstall: number;
  /** المعلَّق الذي لم يُرحَّل بعد. */
  pending: number;
  pagesSinceInstall: number;
  /** ما استُهلك فعلاً بوحدة الأساس (علبة واحدة عادةً). */
  actual: number;
}

export interface ReconcileResult {
  /**
   * ما يُرحَّل للمخزون الآن، **من جهة المستهلك**: موجب = استُهلك أكثر مما
   * رُحِّل (يُخصم)، سالب = أقل (يُعاد). يشمل المعلَّق: التسوية تُصفّر العدّاد.
   */
  correction: number;
  /** المردود الذي تقوله الأرقام الفعلية — `null` بلا صفحات تُقاس عليها. */
  suggestedYieldPages: number | null;
}

/**
 * «ركّبت علبة جديدة»: ما رُحِّل منذ آخر تركيب يُقارَن بما استُهلك فعلاً،
 * والفرق يُرحَّل تسويةً — **فالمخزون يلحق الواقع**، مرةً لكل علبة.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const posted = input.sinceInstall - input.pending;
  const correction = round3(input.actual - posted);
  const suggestedYieldPages =
    input.pagesSinceInstall > 0 && input.actual > 0
      ? Math.round(input.pagesSinceInstall / input.actual)
      : null;
  return { correction: Object.is(correction, -0) ? 0 : correction, suggestedYieldPages };
}

export type RuleProblem = 'yield_needs_page_basis' | 'duplicate' | 'amount_missing';

/**
 * قاعدة صالحة: كمية **أو** مردود، والمردود لا يُعقل إلا بالصفحة أو الورقة
 * («علبة تكفي ٢٠٠٠ نسخة» ليست جملة عن الحبر)، وخيارٌ × مادة مرة واحدة.
 */
export function rulesProblem(
  rules: {
    optionId: number;
    variantId: number;
    basis: ConsumptionBasis;
    qty: number | null;
    yieldPages: number | null;
  }[],
): RuleProblem | null {
  const seen = new Set<string>();
  for (const r of rules) {
    const key = `${r.optionId}:${r.variantId}`;
    if (seen.has(key)) return 'duplicate';
    seen.add(key);
    const hasQty = r.qty !== null && r.qty > 0;
    const hasYield = r.yieldPages !== null && r.yieldPages > 0;
    if (hasQty === hasYield) return 'amount_missing';
    if (hasYield && r.basis !== 'per_printed_page' && r.basis !== 'per_sheet')
      return 'yield_needs_page_basis';
  }
  return null;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function round9(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
