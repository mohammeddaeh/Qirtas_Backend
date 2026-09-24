import { describe, expect, it } from 'vitest';
import {
  computeReturn,
  formatReturnNumber,
  paidUnitPrice,
  returnableQty,
  withinWindow,
  type SoldLine,
} from '../services/return-rules.js';

/**
 * **كل جواب خاطئ هنا مالٌ يخرج من الدرج بلا أن يفشل شيء.**
 *
 * إرجاعٌ بالسعر المعلن بدل المدفوع يعطي الزبون خصمَ العرض نقداً · سقفٌ يتجاهل
 * ما أُرجع سابقاً يقبل إرجاع القطعة مرتين · مهلةٌ تُقاس من فتح السلّة تُقصّر
 * على زبونٍ لم يتأخّر · وتالفٌ يعود للرفّ يقول إن عندك قطعةً جاهزةً للبيع.
 *
 * ولذلك **كل حالة مع نقيضها**: إثبات أن الإرجاع فوق المباع يُرفض لا يكفي وحده
 * (دالّةٌ ترفض كل شيء تنجح فيه، وهي محلٌّ لا يُرجع أبداً).
 */

function sold(over: Partial<SoldLine> = {}): SoldLine {
  return {
    saleLineId: 1,
    variantId: 16,
    qty: 4,
    lineTotalSyp: 8000,
    unitFactor: 1,
    returnedQty: 0,
    ...over,
  };
}

describe('السعر المدفوع فعلاً', () => {
  it('يُشتقّ من مجموع السطر لا من السعر المعلن', () => {
    // ٤ قطع بـ٨٠٠٠ ⇒ ٢٠٠٠ للقطعة، حتى لو كان المعلن ٢٥٠٠ وخصمه عرضٌ انتهى.
    expect(paidUnitPrice(sold())).toBe(2000);
    // وخصم الكاشير يُخفّضه أيضاً: مجموعُ السطر هو ما دخل الدرج.
    expect(paidUnitPrice(sold({ lineTotalSyp: 7200 }))).toBe(1800);
    // وكميةٌ صفر لا تقسم على صفر.
    expect(paidUnitPrice(sold({ qty: 0 }))).toBe(0);
  });
});

describe('السقف', () => {
  it('يطرح ما أُرجع سابقاً، ولا يهبط تحت الصفر', () => {
    expect(returnableQty(sold())).toBe(4);
    expect(returnableQty(sold({ returnedQty: 3 }))).toBe(1);
    // القطعة لا تُرجع مرتين.
    expect(returnableQty(sold({ returnedQty: 4 }))).toBe(0);
    expect(returnableQty(sold({ returnedQty: 9 }))).toBe(0);
  });
});

describe('المهلة', () => {
  const paid = new Date('2026-09-01T10:00:00Z');

  it('اليوم الأخير كامل، وما بعده خارجها', () => {
    // ١٤ يوماً: من اشترى الأول يملك حتى الخامس عشر — وقصُّها عند منتصف
    // الرابع عشر يرفض إرجاعاً وعد به الإيصال.
    expect(withinWindow(paid, new Date('2026-09-15T09:59:00Z'), 14)).toBe(true);
    expect(withinWindow(paid, new Date('2026-09-15T10:00:00Z'), 14)).toBe(true);
    expect(withinWindow(paid, new Date('2026-09-15T10:01:00Z'), 14)).toBe(false);
    // ونفس اليوم داخلها بداهةً — وإثباتُ الرفض وحده ينجح بدالّةٍ ترفض كل شيء.
    expect(withinWindow(paid, paid, 14)).toBe(true);
  });

  it('مهلةُ صفر تعني لا إرجاع إطلاقاً', () => {
    // وهي قرارٌ مشروع، لكنه يجب أن يكون صريحاً — لا أن يُقرأ «بلا حدّ».
    expect(withinWindow(paid, paid, 0)).toBe(false);
    expect(withinWindow(paid, paid, -5)).toBe(false);
  });
});

describe('حساب المرتجع', () => {
  it('يردّ المدفوع، ويحوّل الصالح لوحدة الأساس', () => {
    const result = computeReturn(
      [sold({ saleLineId: 1, unitFactor: 12 })],
      [{ saleLineId: 1, qty: 2, condition: 'sellable' }],
    );
    expect('ok' in result).toBe(true);
    if (!('ok' in result)) return;
    expect(result.ok.totalSyp).toBe(4000);
    expect(result.ok.lines[0]!.unitRefundSyp).toBe(2000);
    // علبة ×١٢ ترجع ٢٤ قطعة للرفّ — لا ٢.
    expect(result.ok.lines[0]!.qtyBase).toBe(24);
  });

  it('التالف يُرَدّ ماله ولا يعود للرفّ', () => {
    const result = computeReturn(
      [sold({ unitFactor: 12 })],
      [{ saleLineId: 1, qty: 1, condition: 'damaged' }],
    );
    if (!('ok' in result)) throw new Error('expected ok');
    // المال كاملاً: عيب البضاعة ليس خطأ الزبون.
    expect(result.ok.totalSyp).toBe(2000);
    // والمخزون لا يتحرّك: قطعةٌ مكسورة بالرصيد تُقرأ جاهزةً للبيع.
    expect(result.ok.lines[0]!.qtyBase).toBe(0);
  });

  it('يرفض ما فوق المتبقّي ويقول كم بقي', () => {
    const result = computeReturn(
      [sold({ returnedQty: 3 })],
      [{ saleLineId: 1, qty: 2, condition: 'sellable' }],
    );
    expect('problem' in result).toBe(true);
    if (!('problem' in result)) return;
    expect(result.problem.kind).toBe('above_returnable');
    // الرقم يسافر مع الرفض: «مرفوض» بلا عددٍ يجعل المحاولة التالية تخميناً.
    if (result.problem.kind === 'above_returnable') expect(result.problem.returnable).toBe(1);

    // والمتبقّي بالضبط يُقبل — لا رفضَ لما وعد به السقف.
    const exact = computeReturn(
      [sold({ returnedQty: 3 })],
      [{ saleLineId: 1, qty: 1, condition: 'sellable' }],
    );
    expect('ok' in exact).toBe(true);
  });

  it('يرفض سطراً ليس بالفاتورة، وكميةً غير موجبة، وطلباً فارغاً', () => {
    const alien = computeReturn([sold()], [{ saleLineId: 99, qty: 1, condition: 'sellable' }]);
    expect('problem' in alien && alien.problem.kind).toBe('line_not_in_sale');

    // كميةٌ سالبة «إرجاعٌ بالسالب» — أي بيعٌ بلا فاتورة.
    const negative = computeReturn([sold()], [{ saleLineId: 1, qty: -2, condition: 'sellable' }]);
    expect('problem' in negative && negative.problem.kind).toBe('qty_not_positive');
    const zero = computeReturn([sold()], [{ saleLineId: 1, qty: 0, condition: 'sellable' }]);
    expect('problem' in zero && zero.problem.kind).toBe('qty_not_positive');

    // ومرتجعٌ بلا أسطر مستندٌ فارغ يأخذ رقماً.
    expect('problem' in computeReturn([sold()], [])).toBe(true);
  });

  it('عدة أسطر تُجمع', () => {
    const result = computeReturn(
      [
        sold({ saleLineId: 1, qty: 2, lineTotalSyp: 4000 }),
        sold({ saleLineId: 2, qty: 1, lineTotalSyp: 1500, variantId: 17 }),
      ],
      [
        { saleLineId: 1, qty: 1, condition: 'sellable' },
        { saleLineId: 2, qty: 1, condition: 'damaged' },
      ],
    );
    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.ok.totalSyp).toBe(3500);
    expect(result.ok.lines).toHaveLength(2);
  });
});

describe('رقم المرتجع', () => {
  it('يحمل حرف R فلا يقطع ترقيم الفواتير', () => {
    expect(formatReturnNumber('MZ', 2026, 1)).toBe('MZ-R-2026-000001');
    // تسلسلٌ مشترك كان سيترك بترقيم البيع فجوةً يقرؤها المدقّق فاتورةً مفقودة.
    expect(formatReturnNumber('MZ', 2026, 1)).not.toBe('MZ-2026-000001');
    expect(formatReturnNumber('', 2026, 7)).toBe('SL-R-2026-000007');
  });
});
