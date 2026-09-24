/**
 * كيف يُحسب مرتجع — دالّات صافية، `orders_delivery.md` §٢.
 *
 * **كل جواب خاطئ هنا مالٌ يخرج من الدرج بلا أن يفشل شيء.** إرجاعٌ بسعر اليوم
 * بدل المدفوع يعطي الزبون أكثر مما دفع · سقفٌ يُحسب بلا ما أُرجع سابقاً يسمح
 * بإرجاع القطعة مرتين · مهلةٌ تُقاس بالتاريخ الخطأ ترفض إرجاعاً مشروعاً أو
 * تقبل واحداً بعد شهرين.
 */

export interface SoldLine {
  saleLineId: number;
  variantId: number;
  qty: number;
  /** ما دفعه الزبون عن السطر كاملاً — بعد العرض وبعد حصّة خصم الكاشير. */
  lineTotalSyp: number;
  /** معامل الوحدة المُباع بها، ليُحوَّل المرتجع إلى وحدة الأساس. */
  unitFactor: number;
  /** ما أُرجع من هذا السطر سابقاً. */
  returnedQty: number;
}

/**
 * **السعر المدفوع فعلاً للوحدة** — مجموعُ السطر مقسوماً على كميته.
 *
 * لا السعر المعلن ولا سعر اليوم: الأول يتجاهل العرض وخصم الكاشير، والثاني
 * يتبع الكتالوج فيتغيّر بعد أسبوع. وكلاهما يُخرج من الدرج مبلغاً غير الذي
 * دخله، والفرق لا يظهر إلا بجرد الصندوق.
 */
export function paidUnitPrice(line: SoldLine): number {
  if (line.qty <= 0) return 0;
  return line.lineTotalSyp / line.qty;
}

/** ما بقي قابلاً للإرجاع — ولا يكون سالباً مهما كان المُرجَع سابقاً. */
export function returnableQty(line: SoldLine): number {
  return Math.max(0, line.qty - Math.max(0, line.returnedQty));
}

/**
 * هل الفاتورة داخل المهلة.
 *
 * تُقاس من **لحظة السداد** لا من فتح السلّة: سلّةٌ فُتحت صباحاً وسُدِّدت مساءً
 * فرقُها ساعات، لكن سلّةً معلَّقة نُسيت أسبوعاً كانت ستُقصّر المهلة أسبوعاً على
 * زبونٍ لم يتأخّر.
 *
 * **واليوم الأخير كامل**: `paidAt + days` لحظةُ الانتهاء، فمن اشترى الأول
 * ومهلته ١٤ يملك حتى الخامس عشر — وقصُّها عند منتصف الرابع عشر يرفض إرجاعاً
 * وعد به الإيصال.
 */
export function withinWindow(paidAt: Date, now: Date, windowDays: number): boolean {
  if (windowDays <= 0) return false;
  const deadline = paidAt.getTime() + windowDays * 24 * 60 * 60 * 1000;
  return now.getTime() <= deadline;
}

export interface ReturnLineInput {
  saleLineId: number;
  qty: number;
  condition: 'sellable' | 'damaged';
}

export interface ReturnLineAmounts {
  saleLineId: number;
  variantId: number;
  qty: number;
  unitRefundSyp: number;
  refundSyp: number;
  condition: 'sellable' | 'damaged';
  /** بوحدة الأساس — الصالح وحده يتحرّك به، والتالف صفر. */
  qtyBase: number;
}

export type ReturnProblem =
  | { kind: 'line_not_in_sale'; saleLineId: number }
  | { kind: 'qty_not_positive'; saleLineId: number }
  | { kind: 'above_returnable'; saleLineId: number; returnable: number }
  | { kind: 'nothing_to_return' };

export interface ReturnComputation {
  lines: ReturnLineAmounts[];
  totalSyp: number;
}

/**
 * ما يُرَدّ عن هذه الأسطر — أو ما يمنع ذلك.
 *
 * **والتالف لا يتحرّك مخزوناً** (`qtyBase = 0`): البضاعة غادرت الرفّ يوم
 * البيع، وإعادتها إليه مكسورةً تقول إن عندك قطعةً جاهزةً للبيع — والجرد
 * يكتشفها بعد شهر. لكن **المال يُرَدّ كاملاً**: عيب البضاعة ليس خطأ الزبون.
 */
export function computeReturn(
  sold: SoldLine[],
  requested: ReturnLineInput[],
): { ok: ReturnComputation } | { problem: ReturnProblem } {
  if (requested.length === 0) return { problem: { kind: 'nothing_to_return' } };
  const byId = new Map(sold.map((line) => [line.saleLineId, line]));
  const lines: ReturnLineAmounts[] = [];

  for (const req of requested) {
    const line = byId.get(req.saleLineId);
    if (!line) return { problem: { kind: 'line_not_in_sale', saleLineId: req.saleLineId } };
    if (req.qty <= 0) return { problem: { kind: 'qty_not_positive', saleLineId: req.saleLineId } };
    const returnable = returnableQty(line);
    if (req.qty > returnable + 1e-9) {
      return { problem: { kind: 'above_returnable', saleLineId: req.saleLineId, returnable } };
    }
    const unit = paidUnitPrice(line);
    lines.push({
      saleLineId: line.saleLineId,
      variantId: line.variantId,
      qty: req.qty,
      unitRefundSyp: Math.round(unit),
      refundSyp: Math.round(unit * req.qty),
      condition: req.condition,
      qtyBase: req.condition === 'sellable' ? req.qty * line.unitFactor : 0,
    });
  }

  return {
    ok: { lines, totalSyp: lines.reduce((sum, l) => sum + l.refundSyp, 0) },
  };
}

/**
 * `MZ-R-2026-000001` — **حرف `R` يفصل المرتجعات عن الفواتير**.
 *
 * تسلسلٌ مشترك كان سيقطع ترقيم البيع بفجوات يقرؤها المدقّق فواتيرَ مفقودة، وهي
 * مرتجعات موجودة تماماً.
 */
export function formatReturnNumber(prefix: string, year: number, sequence: number): string {
  const clean = prefix.trim().toUpperCase().slice(0, 6) || 'SL';
  return `${clean}-R-${year}-${String(sequence).padStart(6, '0')}`;
}
