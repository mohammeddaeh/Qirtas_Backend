import type { PrintOptionKind } from '../schemas/printing.schema.js';

/**
 * قواعد تسعير الطباعة — **دوال صافية بلا قاعدة بيانات**، فتُختبر كل حالة مع
 * نقيضها (`__tests__/print-rules.test.ts`).
 *
 * **الخادم يحسب والعميل يعرض** (نفس قاعدة الكتالوج): نسخةٌ ثانية من «كم
 * يكلّف هذا الملف؟» بالتطبيق تختلف أول تعديل للجدول، والاختلاف مبلغٌ يُطلب من
 * زبون عند الصندوق غير الذي رآه حين أرسل ملفّه.
 */

export interface PrintOption {
  id: number;
  kind: PrintOptionKind;
  code: string;
  isActive: boolean;
}

export interface PrintConfig {
  options: Map<number, PrintOption>;
  /** معطَّلٌ بالفرع — الغياب «مفعَّل». */
  disabledAtBranch: Set<number>;
  centralPageRates: Map<string, number>;
  branchPageRates: Map<string, number>;
  centralFinishing: Map<number, number>;
  branchFinishing: Map<number, number>;
  tiers: { minPages: number; discountPercent: number }[];
}

export interface QuoteInput {
  pages: number;
  copies: number;
  paperSizeId: number;
  colorModeId: number;
  sidesId: number;
  bindingId: number;
  coverId: number;
}

export type RateSource = 'central' | 'branch';

export interface PrintQuote {
  pages: number;
  copies: number;
  /** الصفحات × النسخ — ما تُحسب عليه الشريحة. */
  printedPages: number;
  /** الورق الذي يُستهلك: الوجهان يطبعان صفحتين على الورقة. */
  sheets: number;
  pageRateSyp: number;
  pageRateSource: RateSource;
  pagesSubtotalSyp: number;
  tier: { minPages: number; discountPercent: number } | null;
  tierDiscountSyp: number;
  finishing: {
    optionId: number;
    kind: 'binding' | 'cover';
    perCopySyp: number;
    source: RateSource;
    subtotalSyp: number;
  }[];
  finishingSubtotalSyp: number;
  totalSyp: number;
}

export type QuoteRefusal =
  | { reason: 'option_unknown'; optionId: number }
  | { reason: 'option_wrong_kind'; optionId: number; expected: PrintOptionKind }
  | { reason: 'option_inactive'; optionId: number }
  | { reason: 'option_disabled_at_branch'; optionId: number }
  | { reason: 'spec_unpriced'; optionId: number | null };

export type QuoteResult = { ok: true; quote: PrintQuote } | { ok: false; refusal: QuoteRefusal };

/** مفتاح خلية بمصفوفة سعر الصفحة. */
export function pageRateKey(paperSizeId: number, colorModeId: number, sidesId: number): string {
  return `${paperSizeId}:${colorModeId}:${sidesId}`;
}

/**
 * الوجهان يُعرفان بالرمز لا بالاسم — الاسم يُعدَّل بحرية («وجهان» ↔ «على
 * الوجهين»)، والرمز معرّف ثابت.
 */
export const DOUBLE_SIDED_CODE = 'double';

/**
 * الشريحة الأعلى التي بلغها المجموع — **لا مجموع الشرائح**: ١٠٠ صفحة بشريحتي
 * ٥٠ (٥٪) و١٠٠ (١٠٪) تأخذ ١٠٪ لا ١٥٪.
 */
export function tierFor(
  printedPages: number,
  tiers: { minPages: number; discountPercent: number }[],
): { minPages: number; discountPercent: number } | null {
  let best: { minPages: number; discountPercent: number } | null = null;
  for (const t of tiers) {
    if (printedPages >= t.minPages && (best === null || t.minPages > best.minPages)) best = t;
  }
  return best;
}

/**
 * هل يقع سعر الفرع ضمن النطاق حول المركزي؟ الحدّان داخله (±٢٠٪ تقبل ٨٠ و١٢٠
 * لمركزي ١٠٠) — والسماحية الصغيرة لأن النسبة تُحسب بأعداد عشرية.
 */
export function withinBand(centralSyp: number, proposedSyp: number, bandPercent: number): boolean {
  const low = centralSyp * (1 - bandPercent / 100);
  const high = centralSyp * (1 + bandPercent / 100);
  const eps = 1e-6;
  return proposedSyp >= low - eps && proposedSyp <= high + eps;
}

/** النطاق نفسه أرقاماً — يُعرض **قبل** الكتابة لا بعد الرفض. */
export function bandOf(
  centralSyp: number,
  bandPercent: number,
): { minSyp: number; maxSyp: number } {
  return {
    minSyp: round2(centralSyp * (1 - bandPercent / 100)),
    maxSyp: round2(centralSyp * (1 + bandPercent / 100)),
  };
}

function checkOption(
  config: PrintConfig,
  optionId: number,
  expected: PrintOptionKind,
): QuoteRefusal | PrintOption {
  const option = config.options.get(optionId);
  if (!option) return { reason: 'option_unknown', optionId };
  if (option.kind !== expected) return { reason: 'option_wrong_kind', optionId, expected };
  if (!option.isActive) return { reason: 'option_inactive', optionId };
  if (config.disabledAtBranch.has(optionId))
    return { reason: 'option_disabled_at_branch', optionId };
  return option;
}

const isRefusal = (v: QuoteRefusal | PrintOption): v is QuoteRefusal => 'reason' in v;

/**
 * هل تُطبع هذه المواصفة بهذا الفرع — **بلا سعر**. يُسأل عند إنشاء الطلب
 * وتعديله: الصفحات لم تُعدّ بعد، لكن خياراً موقوفاً أو معطَّلاً بالفرع يُرفض
 * الآن لا بعد أن يرفع الزبون ملفاته.
 */
export function specProblem(
  input: Omit<QuoteInput, 'pages' | 'copies'>,
  config: PrintConfig,
): QuoteRefusal | null {
  const specs: [number, PrintOptionKind][] = [
    [input.paperSizeId, 'paper_size'],
    [input.colorModeId, 'color_mode'],
    [input.sidesId, 'sides'],
    [input.bindingId, 'binding'],
    [input.coverId, 'cover'],
  ];
  for (const [id, kind] of specs) {
    const r = checkOption(config, id, kind);
    if (isRefusal(r)) return r;
  }
  return null;
}

/**
 * سعر طلب طباعة بفرعٍ بعينه.
 *
 * **الفرع أولاً ثم المركزي** لكل خلية على حدة: فرعٌ خفّض الأبيض والأسود وحده
 * يبقى على المركزي بالألوان. وخليةٌ بلا سعر بالاثنين **رفضٌ لا صفر** — صفرٌ
 * يطبع مئة صفحة مجاناً ولا يفشل شيء.
 *
 * `total` بالليرة الكاملة: الكسور تنتج عن نسبة الشريحة، ولا أحد يدفع ٠٫٥ ل.س.
 */
export function quote(input: QuoteInput, config: PrintConfig): QuoteResult {
  const specs: [number, PrintOptionKind][] = [
    [input.paperSizeId, 'paper_size'],
    [input.colorModeId, 'color_mode'],
    [input.sidesId, 'sides'],
    [input.bindingId, 'binding'],
    [input.coverId, 'cover'],
  ];
  const resolved = new Map<PrintOptionKind, PrintOption>();
  for (const [id, kind] of specs) {
    const r = checkOption(config, id, kind);
    if (isRefusal(r)) return { ok: false, refusal: r };
    resolved.set(kind, r);
  }

  const key = pageRateKey(input.paperSizeId, input.colorModeId, input.sidesId);
  const branchRate = config.branchPageRates.get(key);
  const centralRate = config.centralPageRates.get(key);
  const pageRate = branchRate ?? centralRate;
  if (pageRate === undefined)
    return { ok: false, refusal: { reason: 'spec_unpriced', optionId: null } };

  const finishing: PrintQuote['finishing'] = [];
  for (const [id, kind] of [
    [input.bindingId, 'binding'],
    [input.coverId, 'cover'],
  ] as const) {
    const own = config.branchFinishing.get(id);
    const central = config.centralFinishing.get(id);
    const perCopy = own ?? central;
    if (perCopy === undefined)
      return { ok: false, refusal: { reason: 'spec_unpriced', optionId: id } };
    finishing.push({
      optionId: id,
      kind,
      perCopySyp: perCopy,
      source: own === undefined ? 'central' : 'branch',
      subtotalSyp: round2(perCopy * input.copies),
    });
  }

  const doubleSided = resolved.get('sides')!.code === DOUBLE_SIDED_CODE;
  const printedPages = input.pages * input.copies;
  const sheets = Math.ceil(input.pages / (doubleSided ? 2 : 1)) * input.copies;
  const pagesSubtotal = round2(printedPages * pageRate);
  const tier = tierFor(printedPages, config.tiers);
  const tierDiscount = tier === null ? 0 : round2((pagesSubtotal * tier.discountPercent) / 100);
  const finishingSubtotal = round2(finishing.reduce((sum, f) => sum + f.subtotalSyp, 0));

  return {
    ok: true,
    quote: {
      pages: input.pages,
      copies: input.copies,
      printedPages,
      sheets,
      pageRateSyp: pageRate,
      pageRateSource: branchRate === undefined ? 'central' : 'branch',
      pagesSubtotalSyp: pagesSubtotal,
      tier,
      tierDiscountSyp: tierDiscount,
      finishing,
      finishingSubtotalSyp: finishingSubtotal,
      totalSyp: Math.round(pagesSubtotal - tierDiscount + finishingSubtotal),
    },
  };
}

/**
 * شرائح صالحة: عتبات موجبة **بلا تكرار**، ونسب بين صفر ومئة حصراً. عتبتان
 * متساويتان بنسبتين تجعلان «أيّهما؟» جواباً يقرّره ترتيب الصفوف بالقاعدة.
 */
export function tiersProblem(
  tiers: { minPages: number; discountPercent: number }[],
): string | null {
  const seen = new Set<number>();
  for (const t of tiers) {
    if (!Number.isInteger(t.minPages) || t.minPages < 1) return 'print_tier_invalid';
    if (!(t.discountPercent > 0 && t.discountPercent < 100)) return 'print_tier_invalid';
    if (seen.has(t.minPages)) return 'print_tier_duplicate';
    seen.add(t.minPages);
  }
  return null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
