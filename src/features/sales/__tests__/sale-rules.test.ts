import { describe, expect, it } from 'vitest';
import {
  branchPrefix,
  computeTotals,
  creditAvailable,
  formatSaleNumber,
  judgeDiscount,
  netBeforeManual,
  settle,
  spendableCredit,
  taxWithin,
  type SaleLineInput,
} from '../services/sale-rules.js';

/**
 * **كل جواب خاطئ هنا مبلغٌ معقول يدفعه زبون.**
 *
 * ضريبةٌ تُضاف فوق سعرٍ يشملها فيدفع مرتين · خصمٌ لا يُوزَّع فيُرجَع بالمرتجع
 * أكثر مما دُفع · باقٍ يُحسب من غير النقد فينقص الدرج كلما دُفع ببطاقة · سقفٌ
 * يُجمع فيه «مرفوض» مع «يحتاج مديراً» فينتظر الزبون مقابل لا شيء. لا استثناء
 * ولا سجل — الإيصال يُطبع تماماً ويكذب.
 *
 * ولذلك **كل حالة مع نقيضها**: إثبات أن الضريبة تُستخرَج لا يكفي وحده (دالّةٌ
 * تُرجع صفراً دائماً تنجح فيه، وهي فاتورةٌ بلا ضريبة إطلاقاً).
 */

function line(over: Partial<SaleLineInput> = {}): SaleLineInput {
  return {
    variantId: 1,
    qty: 1,
    unitPriceSyp: 1000,
    promotionDiscountSyp: 0,
    taxPercent: null,
    ...over,
  };
}

describe('الضريبة', () => {
  it('تُستخرَج من داخل السعر لا تُضاف فوقه', () => {
    // ١١٥٠٠ شاملة ١٥٪ ⇒ الضريبة ١٥٠٠ والصافي ١٠٠٠٠. وبالإضافة فوقه تصير
    // ١٧٢٥ — والزبون يدفع ضريبة الضريبة.
    expect(Math.round(taxWithin(11500, 15))).toBe(1500);
    expect(Math.round(taxWithin(1000, 0))).toBe(0);
    // والنسبة الغائبة صفر لا افتراضٌ مخترَع.
    expect(taxWithin(1000, null)).toBe(0);
    // ومبلغٌ صفر لا يُنتج ضريبة ولا يقسم على صفر.
    expect(taxWithin(0, 15)).toBe(0);
  });
});

describe('صافي السطر', () => {
  it('خصم العرض يُحسم قبل الضرب بالكمية، ولا ينزل السعر تحت الصفر', () => {
    expect(netBeforeManual(line({ qty: 3, unitPriceSyp: 1000 }))).toBe(3000);
    expect(netBeforeManual(line({ qty: 3, promotionDiscountSyp: 200 }))).toBe(2400);
    // خصمٌ أكبر من السعر يعني سطراً سالباً يمرّ بكل جمعٍ بعده بلا اعتراض.
    expect(netBeforeManual(line({ qty: 2, promotionDiscountSyp: 5000 }))).toBe(0);
    // وكميةٌ سالبة ليست إرجاعاً بهذا المسار — تُقرأ صفراً لا مبلغاً يُردّ.
    expect(netBeforeManual(line({ qty: -3 }))).toBe(0);
  });
});

describe('مجاميع الفاتورة', () => {
  it('بلا خصم يدوي: المجموع هو مجموع السطور', () => {
    const totals = computeTotals([line({ qty: 2 }), line({ variantId: 2, unitPriceSyp: 500 })], 0);
    expect(totals.subtotalSyp).toBe(2500);
    expect(totals.totalSyp).toBe(2500);
    expect(totals.discountSyp).toBe(0);
    // ولا ضريبة حين لا نسبة — لا رقمٌ مخترَع بسطر الضريبة.
    expect(totals.taxSyp).toBe(0);
  });

  it('خصم الكاشير يُوزَّع على السطور، ومجموع السطور يساوي المجموع بالضبط', () => {
    // التوزيع ليس تجميلاً: المرتجع يُرجع بالسعر المدفوع فعلاً، وسطرٌ بلا حصّته
    // يُرجَع بأكثر مما دُفع فيه.
    const totals = computeTotals(
      [line({ qty: 1, unitPriceSyp: 1000 }), line({ variantId: 2, qty: 1, unitPriceSyp: 2000 })],
      10,
    );
    expect(totals.totalSyp).toBe(2700);
    expect(totals.lines[0]!.manualDiscountSyp).toBe(100);
    expect(totals.lines[1]!.manualDiscountSyp).toBe(200);
    // مجموع السطور = المجموع المعروض، بلا انحراف تقريب.
    expect(totals.lines.reduce((s, l) => s + l.lineTotalSyp, 0)).toBe(totals.totalSyp);
  });

  it('فرق التقريب يُسوَّى فلا يختلف الإيصال عن نفسه', () => {
    // ثلاثة سطور متساوية وخصمٌ لا يقبل القسمة: ١٠٪ من ١٠٠٠×٣ = ٣٠٠ بالضبط،
    // و٣٣٫٣٪ تُنتج كسوراً — والمجموع يجب أن يبقى متطابقاً بالحالتين.
    for (const percent of [10, 33.33, 7.77]) {
      const totals = computeTotals(
        [line(), line({ variantId: 2 }), line({ variantId: 3 })],
        percent,
      );
      expect(totals.lines.reduce((s, l) => s + l.lineTotalSyp, 0)).toBe(totals.totalSyp);
    }
  });

  it('الضريبة تُحسب على المدفوع بعد الخصم لا على المعلن', () => {
    // خصمٌ على سعرٍ شامل الضريبة يخفّض الضريبة معه — وحسابُها على المعلن
    // يجعل المتجر يورّد ضريبة مالٍ لم يقبضه.
    const totals = computeTotals([line({ unitPriceSyp: 11500, taxPercent: 15 })], 50);
    expect(totals.totalSyp).toBe(5750);
    expect(totals.taxSyp).toBe(750);
    // وبلا خصم: الضريبة كاملة.
    expect(computeTotals([line({ unitPriceSyp: 11500, taxPercent: 15 })], 0).taxSyp).toBe(1500);
  });

  it('خصم مئة بالمئة يُفرغ الفاتورة ولا يجعلها سالبة', () => {
    const totals = computeTotals([line({ qty: 2 })], 100);
    expect(totals.totalSyp).toBe(0);
    expect(totals.lines[0]!.lineTotalSyp).toBe(0);
    // وما فوق المئة يُقصّ عندها — لا فاتورة يدفع فيها المتجر للزبون.
    expect(computeTotals([line({ qty: 2 })], 500).totalSyp).toBe(0);
    // والسالب يُقرأ صفراً: خصمٌ سالب يرفع الفاتورة فوق سعرها المعلن.
    expect(computeTotals([line({ qty: 2 })], -30).totalSyp).toBe(2000);
  });

  it('فاتورة بلا سطور مجموعها صفر ولا ترمي', () => {
    const totals = computeTotals([], 20);
    expect(totals.totalSyp).toBe(0);
    expect(totals.lines).toEqual([]);
  });
});

describe('سقف خصم الكاشير', () => {
  it('ثلاثة أجوبة لا اثنان', () => {
    // داخل سقفه: يمضي بلا أن يُستدعى أحد.
    expect(judgeDiscount(5, 5, 20).kind).toBe('within_cap');
    expect(judgeDiscount(3, 5, 20).kind).toBe('within_cap');
    // فوق سقفه ودون الأعلى: مديرٌ يوافق.
    expect(judgeDiscount(12, 5, 20).kind).toBe('needs_approval');
    expect(judgeDiscount(20, 5, 20).kind).toBe('needs_approval');
    // وفوق أعلى سقفٍ بالمنظمة: **مرفوض** — لا أحد يستطيع الموافقة، واستدعاء
    // مديرٍ لخصمٍ لن يُقبل يجعل الزبون ينتظر مقابل لا شيء.
    expect(judgeDiscount(21, 5, 20).kind).toBe('refused');
  });

  it('دورٌ بلا سقف لا يخصم شيئاً، والصفر ليس «بلا حدّ»', () => {
    // كاشيرٌ جديد لا صفّ له = صفر، فأول ليرة خصم تحتاج مديراً.
    expect(judgeDiscount(1, 0, 20).kind).toBe('needs_approval');
    expect(judgeDiscount(0, 0, 20).kind).toBe('within_cap');
  });
});

describe('التسديد', () => {
  it('الباقي من النقد وحده', () => {
    const cash = settle([{ method: 'cash', amountSyp: 4300, tenderedSyp: 5000 }], 4300);
    expect(cash.remainingSyp).toBe(0);
    expect(cash.changeSyp).toBe(700);
    // بطاقةٌ لا تُرجع فكّة — وحسابُ الباقي من المجموع يُنقص الدرج كل مرة.
    const card = settle([{ method: 'card', amountSyp: 4300 }], 4300);
    expect(card.changeSyp).toBe(0);
    expect(card.remainingSyp).toBe(0);
  });

  it('النقص يبقى نقصاً، والدفع المختلط يُجمع', () => {
    const partial = settle([{ method: 'cash', amountSyp: 2000 }], 5000);
    // فاتورةٌ تُقفل على نقصٍ هي بضاعةٌ خرجت بلا ثمنها.
    expect(partial.remainingSyp).toBe(3000);
    const mixed = settle(
      [
        { method: 'cash', amountSyp: 2000, tenderedSyp: 2000 },
        { method: 'card', amountSyp: 3000 },
      ],
      5000,
    );
    expect(mixed.remainingSyp).toBe(0);
    expect(mixed.changeSyp).toBe(0);
    expect(mixed.paidSyp).toBe(5000);
  });

  it('بلا دفعات: كل المبلغ باقٍ', () => {
    expect(settle([], 5000).remainingSyp).toBe(5000);
    expect(settle([], 5000).changeSyp).toBe(0);
  });
});

describe('رصيد الزبون والآجل', () => {
  it('المتاح يحسب ما عليه، والسقف الغائب يعني لا آجل', () => {
    expect(creditAvailable(0, 100000)).toBe(100000);
    // عليه ٣٠٬٠٠٠ ⇒ يملك ٧٠٬٠٠٠ لا ١٠٠٬٠٠٠.
    expect(creditAvailable(-30000, 100000)).toBe(70000);
    // وله رصيد ⇒ يزيد متاحه.
    expect(creditAvailable(20000, 100000)).toBe(120000);
    // وتجاوزٌ سابق لا يفتح له المزيد.
    expect(creditAvailable(-150000, 100000)).toBe(0);
    // **وبلا سقف مكتوب لا آجل إطلاقاً**: افتراضٌ مفتوح يُقرض كل زبون بصمت.
    expect(creditAvailable(0, null)).toBe(0);
    expect(creditAvailable(0, 0)).toBe(0);
  });

  it('الدَّين لا يُنفَق', () => {
    expect(spendableCredit(20000)).toBe(20000);
    // رصيدٌ سالب دَينٌ علينا مطالبته، لا مالٌ يشتري به.
    expect(spendableCredit(-20000)).toBe(0);
    expect(spendableCredit(0)).toBe(0);
  });
});

describe('رقم الفاتورة', () => {
  it('يحمل الفرع والسنة والتسلسل بستّ خانات', () => {
    expect(formatSaleNumber('MZ', 2026, 123)).toBe('MZ-2026-000123');
    expect(formatSaleNumber('mz', 2026, 1)).toBe('MZ-2026-000001');
    // ورقمٌ يتجاوز ستّ خانات لا يُقصّ — قصُّه يُنتج رقمين متطابقين.
    expect(formatSaleNumber('MZ', 2026, 1234567)).toBe('MZ-2026-1234567');
  });

  it('البادئة تُشتقّ من الاسم اللاتيني، والعربي يأخذ رقم فرعه', () => {
    expect(branchPrefix('Mazzeh Branch', 7)).toBe('MA');
    // الاسم العربي لا يُشتقّ منه حرفان لاتينيان — ورقمُ الفرع جوابٌ فريد،
    // بخلاف بادئةٍ مخترَعة يتشاركها فرعان فيتصادم رقماهما.
    expect(branchPrefix('فرع المزة', 7)).toBe('BR7');
    expect(branchPrefix('', 3)).toBe('BR3');
    expect(branchPrefix('A', 3)).toBe('BR3');
  });
});
