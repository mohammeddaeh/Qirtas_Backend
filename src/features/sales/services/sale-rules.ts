/**
 * كيف تُحسب فاتورة — دالّات صافية، `orders_delivery.md` §الفوترة و
 * `store_system.md` §٦ و§١١.
 *
 * **كل جواب خاطئ هنا مبلغٌ معقول يدفعه زبون.** الضريبة تُضاف فوق سعرٍ يشملها
 * أصلاً فيدفع مرتين · خصمٌ يُوزَّع خطأً فيُرجَع بالمرتجع أكثر مما دُفع · باقٍ
 * يُحسب بالخطأ فيُفتح الدرج على عجز. لا استثناء ولا سجل — الإيصال يُطبع تماماً.
 */

/** الليرة السورية بلا كسور بالتعامل، والحساب يبقى دقيقاً ثم يُقرَّب مرة واحدة. */
export function roundSyp(value: number): number {
  return Math.round(value);
}

export interface SaleLineInput {
  variantId: number;
  qty: number;
  /** سعر الوحدة المُباع بها **شاملاً الضريبة** (§١١: ما على الرف هو ما يُدفع). */
  unitPriceSyp: number;
  /** ما خفّضه عرضٌ عن سعر الوحدة، قبل خصم الكاشير. */
  promotionDiscountSyp: number;
  /** نسبة الضريبة الفعّالة للتصنيف. `null` = صفر (لا ضريبة). */
  taxPercent: number | null;
}

export interface SaleLineAmounts {
  variantId: number;
  /** السعر المعلن × الكمية — قبل أي خصم. */
  grossSyp: number;
  promotionDiscountSyp: number;
  /** حصّة السطر من خصم الكاشير. */
  manualDiscountSyp: number;
  /** ما يدفعه الزبون عن هذا السطر فعلاً. */
  lineTotalSyp: number;
  /** الضريبة **المستخرَجة من داخل** `lineTotalSyp`، لا المضافة فوقه. */
  taxSyp: number;
  taxPercent: number;
}

/**
 * الضريبة **تُستخرَج من داخل السعر** (§١١).
 *
 * السعر المعروض شاملٌ لها بعرف المستهلك، فإضافتها فوقه تجعل الزبون يدفع مرتين
 * — والفرق يمرّ بلا اعتراض لأن كل رقم بالإيصال يبدو معقولاً.
 *
 * `total × rate / (100 + rate)` — لا `total × rate / 100`.
 */
export function taxWithin(totalSyp: number, taxPercent: number | null): number {
  if (taxPercent === null || taxPercent <= 0 || totalSyp <= 0) return 0;
  return (totalSyp * taxPercent) / (100 + taxPercent);
}

/** المبلغ قبل خصم الكاشير: (السعر − خصم العرض) × الكمية، ولا يهبط تحت الصفر. */
export function netBeforeManual(line: SaleLineInput): number {
  const unit = Math.max(0, line.unitPriceSyp - Math.max(0, line.promotionDiscountSyp));
  return Math.max(0, unit * Math.max(0, line.qty));
}

export interface SaleTotals {
  lines: SaleLineAmounts[];
  /** مجموع الأسعار المعلنة — به يُرى ما وفّره الزبون. */
  subtotalSyp: number;
  /** خصم العرض + خصم الكاشير معاً. */
  discountSyp: number;
  taxSyp: number;
  totalSyp: number;
}

/**
 * الفاتورة كاملةً، والخصم اليدوي **يُوزَّع على السطور بنسبة أنصبتها**.
 *
 * التوزيع ليس تجميلاً: المرتجع يُرجع **بالسعر المدفوع فعلاً** لا بالمعلن
 * (§٢)، فسطرٌ بلا حصّته من الخصم يُرجَع بأكثر مما دُفع فيه — والفرق يخرج من
 * الدرج بلا أن يفشل شيء.
 *
 * **وفرق التقريب يذهب لأكبر سطر**: توزيع ١٠٠ على ثلاثة يُنتج ٣٣+٣٣+٣٣، ومجموعُ
 * السطور يجب أن يساوي المجموع المعروض بالضبط — وإلا اختلف الإيصال عن نفسه.
 */
export function computeTotals(lines: SaleLineInput[], discountPercent: number): SaleTotals {
  const percent = Math.max(0, Math.min(100, discountPercent));
  const nets = lines.map(netBeforeManual);
  const netSum = nets.reduce((sum, n) => sum + n, 0);
  const manualTotal = roundSyp((netSum * percent) / 100);

  // الحصص بالتقريب أولاً، ثم يُسوَّى الفرق على أكبر سطر.
  const shares = nets.map((net) => (netSum <= 0 ? 0 : roundSyp((manualTotal * net) / netSum)));
  const drift = manualTotal - shares.reduce((sum, s) => sum + s, 0);
  if (drift !== 0 && shares.length > 0) {
    let biggest = 0;
    for (let i = 1; i < nets.length; i += 1) if (nets[i]! > nets[biggest]!) biggest = i;
    shares[biggest] = Math.max(0, shares[biggest]! + drift);
  }

  const out: SaleLineAmounts[] = lines.map((line, i) => {
    const gross = roundSyp(Math.max(0, line.unitPriceSyp) * Math.max(0, line.qty));
    const promo = roundSyp(gross - nets[i]!);
    const manual = Math.min(shares[i]!, nets[i]!);
    const total = roundSyp(nets[i]! - manual);
    return {
      variantId: line.variantId,
      grossSyp: gross,
      promotionDiscountSyp: promo,
      manualDiscountSyp: roundSyp(manual),
      lineTotalSyp: total,
      taxSyp: roundSyp(taxWithin(total, line.taxPercent)),
      taxPercent: line.taxPercent ?? 0,
    };
  });

  const totalSyp = out.reduce((sum, l) => sum + l.lineTotalSyp, 0);
  return {
    lines: out,
    subtotalSyp: out.reduce((sum, l) => sum + l.grossSyp, 0),
    discountSyp: out.reduce((sum, l) => sum + l.promotionDiscountSyp + l.manualDiscountSyp, 0),
    taxSyp: out.reduce((sum, l) => sum + l.taxSyp, 0),
    totalSyp,
  };
}

// ── الخصم اليدوي وسقفه (§٦) ─────────────────────────────────────────────────

export type DiscountVerdict =
  | { kind: 'within_cap' }
  | { kind: 'needs_approval'; capPercent: number }
  | { kind: 'refused'; capPercent: number };

/**
 * هل يملك هذا الكاشير هذا الخصم.
 *
 * **ثلاثة أجوبة لا اثنان**: «مسموح» · «يحتاج مديراً» · «مرفوض مهما وافق أحد».
 * جمعُ الأخيرين يجعل الكاشير يستدعي مديراً لخصمٍ لن يُقبل بأي حال، ويجعل
 * الزبون ينتظر مقابل لا شيء.
 *
 * والسقف المطلق `maxApprovablePercent` هو أعلى سقفٍ يملكه أحد بالمنظمة: فوقه
 * لا يوجد من يوافق، فالرفض هو الجواب الصادق.
 */
export function judgeDiscount(
  requestedPercent: number,
  cashierCapPercent: number,
  maxApprovablePercent: number,
): DiscountVerdict {
  const requested = Math.max(0, requestedPercent);
  if (requested <= cashierCapPercent + 1e-9) return { kind: 'within_cap' };
  if (requested <= maxApprovablePercent + 1e-9) {
    return { kind: 'needs_approval', capPercent: cashierCapPercent };
  }
  return { kind: 'refused', capPercent: maxApprovablePercent };
}

// ── الدفع ───────────────────────────────────────────────────────────────────

export interface PaymentInput {
  method: 'cash' | 'card' | 'customer_credit' | 'on_account';
  amountSyp: number;
  tenderedSyp?: number | null;
}

export interface PaymentOutcome {
  /** مجموع ما سُدِّد. */
  paidSyp: number;
  /** الباقي للزبون — نقداً فقط، ولا يكون سالباً. */
  changeSyp: number;
  /** ما بقي على الفاتورة. أكبر من صفر ⇒ لا تُسدَّد. */
  remainingSyp: number;
}

/**
 * ما دُفع وما بقي وكم الباقي.
 *
 * **الباقي من النقد وحده**: بطاقةٌ تُمرَّر بمبلغٍ محدَّد لا تُرجع فكّة، وحسابُه
 * من المجموع يجعل الدرج ينقص كلما دفع أحدهم ببطاقة.
 *
 * **والزيادة نقداً باقٍ لا إكرامية**: كاشيرٌ يقبض ٥٬٠٠٠ عن فاتورة ٤٬٣٠٠ يعيد
 * ٧٠٠ — وابتلاعها بالمجموع يجعل الفاتورة تقول إن الزبون دفع أكثر مما اشترى.
 */
export function settle(payments: PaymentInput[], totalSyp: number): PaymentOutcome {
  let applied = 0;
  let cashTendered = 0;
  for (const p of payments) {
    const amount = Math.max(0, p.amountSyp);
    applied += amount;
    if (p.method === 'cash') cashTendered += Math.max(amount, p.tenderedSyp ?? 0);
  }
  const remaining = roundSyp(Math.max(0, totalSyp - applied));
  const cashApplied = payments
    .filter((p) => p.method === 'cash')
    .reduce((sum, p) => sum + Math.max(0, p.amountSyp), 0);
  return {
    paidSyp: roundSyp(applied),
    changeSyp: roundSyp(Math.max(0, cashTendered - cashApplied)),
    remainingSyp: remaining,
  };
}

/**
 * كم يستطيع هذا الزبون أن يأخذ آجلاً الآن.
 *
 * الرصيد موجبٌ = له عندنا · سالبٌ = علينا. والمتاح `limit + balance`: زبونٌ
 * سقفه ١٠٠٬٠٠٠ وعليه ٣٠٬٠٠٠ يملك ٧٠٬٠٠٠ — وحسابُه من السقف وحده يُقرض من
 * تجاوزه مرة أخرى.
 *
 * **وبلا سقف مكتوب لا آجل إطلاقاً**: افتراضٌ مفتوح يُقرض كل زبون بصمت.
 */
export function creditAvailable(balanceSyp: number, limitSyp: number | null): number {
  if (limitSyp === null || limitSyp <= 0) return 0;
  return Math.max(0, limitSyp + balanceSyp);
}

/** ما يستطيع الزبون إنفاقه من رصيده — الموجب وحده، فالدَّين لا يُنفَق. */
export function spendableCredit(balanceSyp: number): number {
  return Math.max(0, balanceSyp);
}

// ── الترقيم ─────────────────────────────────────────────────────────────────

/**
 * `MZ-2026-000123` — بادئة الفرع، ثم السنة، ثم ستّ خانات.
 *
 * السنة جزءٌ من الرقم **والتسلسل يبدأ من واحد بكل سنة**: عدّادٌ لا ينتهي يجعل
 * أرقام السنة الخامسة سبع خانات، والمحاسب يقرأ رقماً لا يعرف سنته.
 */
export function formatSaleNumber(prefix: string, year: number, sequence: number): string {
  const clean = prefix.trim().toUpperCase().slice(0, 6) || 'SL';
  return `${clean}-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * بادئة الفرع من اسمه: أول حرفين لاتينيين، وإلا `BR<id>`.
 *
 * الاسم العربي لا يُشتقّ منه حرفان لاتينيان، ورقمُ الفرع جوابٌ صادق يبقى
 * فريداً — بخلاف بادئةٍ مخترَعة يتشاركها فرعان فيتصادم رقماهما.
 */
export function branchPrefix(name: string, branchId: number): string {
  const letters = name.replace(/[^A-Za-z]/g, '');
  return letters.length >= 2 ? letters.slice(0, 2).toUpperCase() : `BR${branchId}`;
}
