import { describe, expect, it } from 'vitest';
import {
  appliesTo,
  applyBasket,
  capApplies,
  freeUnitsOf,
  isLive,
  lossWarningsFor,
  maxPercentOf,
  resolveLine,
  statusOf,
  tierFor,
  unitDiscountOf,
  type Promotion,
  type PromotionContext,
  type PromotionItem,
} from '../services/promotion-rules.js';

/**
 * **عرضٌ يُحسب خطأً رقمٌ معقول على الرفّ.**
 *
 * ينطبق حيث لا يجب فتُباع البضاعة بخسارة · لا ينطبق حيث يجب فيدفع الزبون أكثر
 * من المُعلَن · عرضان يُجمعان فيصير الصنف مجانياً · نافذةٌ منتهية تبقى تبيع.
 * ولا شيء من هذا يرمي ولا يُسجَّل — الفاتورة تُطبع تماماً وتكذب.
 *
 * ولذلك **كل حالة مع نقيضها**: إثبات أن عرضاً منتهياً لا ينطبق لا يُثبت شيئاً
 * وحده (دالّةٌ تردّ كل العروض تنجح فيه، وهي متجرٌ بلا تخفيضات إطلاقاً).
 */

const now = new Date('2026-09-23T10:00:00Z');

const ctx: PromotionContext = { branchId: 3, channel: 'online', segment: 'retail', now };

function promo(over: Partial<Promotion> = {}): Promotion {
  return {
    id: 1,
    nameAr: 'عرض',
    kind: 'percent',
    target: { kind: 'category', id: 10 },
    branchIds: null,
    percent: 10,
    amountSyp: null,
    buyQty: null,
    getQty: null,
    getPercent: null,
    tiers: [],
    startsAt: null,
    endsAt: null,
    channel: 'both',
    segment: 'all',
    isStackable: false,
    isActive: true,
    archivedAt: null,
    ...over,
  };
}

function item(over: Partial<PromotionItem> = {}): PromotionItem {
  return {
    variantId: 100,
    productId: 50,
    categoryPath: [12, 10],
    brandId: 7,
    basePriceSyp: 1000,
    qty: 1,
    ...over,
  };
}

describe('حالة العرض', () => {
  it('الأربع مختلفة، والنافذة تُغلق عند نهايتها لا بعدها', () => {
    expect(statusOf(promo(), now)).toBe('live');
    expect(statusOf(promo({ isActive: false }), now)).toBe('inactive');
    expect(statusOf(promo({ archivedAt: now }), now)).toBe('archived');
    expect(statusOf(promo({ startsAt: new Date('2026-10-01T00:00:00Z') }), now)).toBe('scheduled');
    expect(statusOf(promo({ endsAt: new Date('2026-09-01T00:00:00Z') }), now)).toBe('ended');
    // `endsAt` لحظة التوقّف: عندها بالضبط انتهى، وقبلها بثانية ما زال عرضاً.
    expect(statusOf(promo({ endsAt: now }), now)).toBe('ended');
    expect(statusOf(promo({ endsAt: new Date(now.getTime() + 1000) }), now)).toBe('live');
    // والبداية تفتح عند لحظتها لا بعدها.
    expect(statusOf(promo({ startsAt: now }), now)).toBe('live');
  });

  it('المؤرشف مؤرشف وإن كان فعّالاً وبنافذة مفتوحة', () => {
    // وإلا عاد عرضٌ أُخفي من القوائم يبيع من خلفها.
    expect(statusOf(promo({ archivedAt: now, isActive: true }), now)).toBe('archived');
  });
});

describe('السريان', () => {
  it('الفرع والقناة والشريحة كلها تُفحص — وسقوط أيٍّ منها يُطبّق العرض حيث لا يجب', () => {
    expect(isLive(promo(), ctx)).toBe(true);

    // الفرع: `null` كل الفروع، والقائمة تحصره.
    expect(isLive(promo({ branchIds: [3] }), ctx)).toBe(true);
    expect(isLive(promo({ branchIds: [4] }), ctx)).toBe(false);
    // نطاق «فروع محددة» بلا فرع واحد لا ينطبق على أحد — لا على الجميع.
    expect(isLive(promo({ branchIds: [] }), ctx)).toBe(false);

    // القناة: عرض الإنترنت لا يُطبَّق بالكاشير.
    expect(isLive(promo({ channel: 'online' }), ctx)).toBe(true);
    expect(isLive(promo({ channel: 'pos' }), ctx)).toBe(false);
    expect(isLive(promo({ channel: 'pos' }), { ...ctx, channel: 'pos' })).toBe(true);

    // الشريحة: عرض الجملة لا يُعطى لزبون تجزئة.
    expect(isLive(promo({ segment: 'wholesale' }), ctx)).toBe(false);
    expect(isLive(promo({ segment: 'wholesale' }), { ...ctx, segment: 'wholesale' })).toBe(true);
    expect(isLive(promo({ segment: 'retail' }), ctx)).toBe(true);
  });
});

describe('الانطباق على الصنف', () => {
  it('الهدف يُطابَق بنوعه، والتصنيف يرث للأبناء', () => {
    expect(appliesTo(promo({ target: { kind: 'variant', id: 100 } }), item())).toBe(true);
    expect(appliesTo(promo({ target: { kind: 'variant', id: 101 } }), item())).toBe(false);
    expect(appliesTo(promo({ target: { kind: 'product', id: 50 } }), item())).toBe(true);
    expect(appliesTo(promo({ target: { kind: 'product', id: 51 } }), item())).toBe(false);
    expect(appliesTo(promo({ target: { kind: 'brand', id: 7 } }), item())).toBe(true);
    expect(appliesTo(promo({ target: { kind: 'brand', id: 8 } }), item())).toBe(false);
    // صنفٌ بلا ماركة لا يطابق أي عرض ماركة — ولا يرمي.
    expect(appliesTo(promo({ target: { kind: 'brand', id: 7 } }), item({ brandId: null }))).toBe(
      false,
    );

    // التصنيف: الأب يشمل ابنه (المسار كاملاً)، والتصنيف الغريب لا.
    expect(appliesTo(promo({ target: { kind: 'category', id: 10 } }), item())).toBe(true);
    expect(appliesTo(promo({ target: { kind: 'category', id: 12 } }), item())).toBe(true);
    expect(appliesTo(promo({ target: { kind: 'category', id: 99 } }), item())).toBe(false);
  });
});

describe('خصم الوحدة', () => {
  it('النسبة والمبلغ يُحسبان، والمبلغ مسقوف بالسعر', () => {
    expect(unitDiscountOf(promo({ kind: 'percent', percent: 25 }), item())).toBe(250);
    expect(unitDiscountOf(promo({ kind: 'amount', amountSyp: 300 }), item())).toBe(300);
    // مبلغ أكبر من السعر يعني سعراً سالباً — متجرٌ يدفع لمن يأخذ بضاعته.
    expect(unitDiscountOf(promo({ kind: 'amount', amountSyp: 5000 }), item())).toBe(1000);
    // ونسبة بلا قيمة صفر لا «كل السعر».
    expect(unitDiscountOf(promo({ kind: 'percent', percent: null }), item())).toBe(0);
  });

  it('شرائح الكمية تأخذ الأعلى انطباقاً لا مجموعها، ولا شيء تحت أصغرها', () => {
    const tiers = [
      { minQty: 5, percent: 10, amountSyp: null },
      { minQty: 10, percent: 20, amountSyp: null },
    ];
    expect(tierFor(tiers, 4)).toBeNull();
    expect(tierFor(tiers, 5)?.minQty).toBe(5);
    expect(tierFor(tiers, 9)?.minQty).toBe(5);
    expect(tierFor(tiers, 20)?.minQty).toBe(10);

    const tiered = promo({ kind: 'qty_tiers', percent: null, tiers });
    // الكمية ٢٠ تأخذ ٢٠٪ لا ٣٠٪ (مجموع الشريحتين).
    expect(unitDiscountOf(tiered, item({ qty: 20 }))).toBe(200);
    expect(unitDiscountOf(tiered, item({ qty: 5 }))).toBe(100);
    // وتحت أصغر شريحة لا خصم — وهي الحالة التي تُقرأ خطأً «العرض لا يعمل».
    expect(unitDiscountOf(tiered, item({ qty: 4 }))).toBe(0);
  });

  it('«اشترِ X خذ Y» لا يُحسب بسعر البند إطلاقاً', () => {
    // حسابه هنا يعرض «٢٥٪ خصم» على صفحة منتجٍ يشتري منه الزبون واحداً فلا
    // يأخذ شيئاً — وعدٌ لا يُوفى بأول سلّة.
    const bxgy = promo({ kind: 'buy_x_get_y', percent: null, buyQty: 3, getQty: 1 });
    expect(unitDiscountOf(bxgy, item({ qty: 4 }))).toBe(0);
    expect(resolveLine([bxgy], item({ qty: 4 }), ctx).unitAfterSyp).toBe(1000);
  });
});

describe('الأفضل للزبون', () => {
  it('عرضان غير متراكمين ⇒ الأكبر خصماً وحده، لا مجموعهما', () => {
    const out = resolveLine(
      [
        promo({ id: 1, percent: 10 }),
        promo({ id: 2, percent: 30, target: { kind: 'product', id: 50 } }),
      ],
      item(),
      ctx,
    );
    expect(out.unitAfterSyp).toBe(700);
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0]?.promotionId).toBe(2);
  });

  it('المتراكم يُطبَّق على المتبقّي — خصمان ٥٠٪ يعطيان ٧٥٪ لا بضاعة مجانية', () => {
    const out = resolveLine(
      [
        promo({ id: 1, percent: 50, isStackable: true }),
        promo({ id: 2, percent: 50, isStackable: true, target: { kind: 'product', id: 50 } }),
      ],
      item(),
      ctx,
    );
    expect(out.unitAfterSyp).toBe(250);
    expect(out.applied).toHaveLength(2);
    // ولا يهبط تحت الصفر مهما تراكم.
    const many = resolveLine(
      [1, 2, 3, 4, 5].map((id) =>
        promo({ id, percent: 90, isStackable: true, target: { kind: 'variant', id: 100 } }),
      ),
      item(),
      ctx,
    );
    expect(many.unitAfterSyp).toBeGreaterThanOrEqual(0);
  });

  it('المتراكم يعلو الأفضل من غير المتراكم', () => {
    const out = resolveLine(
      [
        promo({ id: 1, percent: 20 }),
        promo({ id: 2, percent: 50, target: { kind: 'product', id: 50 } }),
        promo({ id: 3, percent: 10, isStackable: true, target: { kind: 'brand', id: 7 } }),
      ],
      item(),
      ctx,
    );
    // ٥٠٪ (الأفضل الحصري) ثم ١٠٪ على المتبقّي = ٤٥٠.
    expect(out.unitAfterSyp).toBe(450);
    expect(out.applied.map((a) => a.promotionId)).toEqual([2, 3]);
  });

  it('لا عرض منطبق ⇒ السعر كما هو، وقائمة فارغة لا خصم صفري مخترَع', () => {
    // «خصم ٠ ل.س» على بطاقة يُقرأ عرضاً، ويُرسل من يبحث عنه ليجده.
    const out = resolveLine([promo({ branchIds: [99] })], item(), ctx);
    expect(out.unitAfterSyp).toBe(1000);
    expect(out.applied).toEqual([]);
    expect(resolveLine([], item(), ctx).applied).toEqual([]);
  });

  it('الجواب لا يتغيّر بترتيب وصول الصفوف', () => {
    const a = promo({ id: 5, percent: 30 });
    const b = promo({ id: 6, percent: 30, target: { kind: 'variant', id: 100 } });
    const first = resolveLine([a, b], item(), ctx);
    const second = resolveLine([b, a], item(), ctx);
    // خصمان متساويان ⇒ الأدقّ هدفاً يفوز، بأي ترتيب وصلا.
    expect(first.applied[0]?.promotionId).toBe(6);
    expect(second.applied[0]?.promotionId).toBe(6);
  });
});

describe('اشترِ X خذ Y', () => {
  it('المجموعة تُعدّ كاملة، والكمية الناقصة لا تُعطي شيئاً', () => {
    const p = promo({ kind: 'buy_x_get_y', percent: null, buyQty: 3, getQty: 1 });
    // ٣ مشتراة وحدها ليست مجموعة: الوعد «اشترِ ٣ خذ الرابعة».
    expect(freeUnitsOf(p, item({ qty: 3 }))).toBeNull();
    expect(freeUnitsOf(p, item({ qty: 4 }))?.qty).toBe(1);
    expect(freeUnitsOf(p, item({ qty: 7 }))?.qty).toBe(1);
    expect(freeUnitsOf(p, item({ qty: 8 }))?.qty).toBe(2);
    expect(freeUnitsOf(p, item({ qty: 8 }))?.discountSyp).toBe(2000);
  });

  it('الهدية المخفَّضة ليست مجانية، والعرض الناقص لا يُنتج هدية', () => {
    const half = promo({
      kind: 'buy_x_get_y',
      percent: null,
      buyQty: 1,
      getQty: 1,
      getPercent: 50,
    });
    expect(freeUnitsOf(half, item({ qty: 2 }))?.discountSyp).toBe(500);
    // وبلا كميات لا هدية — ولا انهيار.
    expect(freeUnitsOf(promo({ kind: 'buy_x_get_y', buyQty: null, getQty: 1 }), item({ qty: 9 }))).toBeNull();
    expect(freeUnitsOf(promo({ kind: 'percent' }), item({ qty: 9 }))).toBeNull();
  });
});

describe('السلّة', () => {
  it('الهدية تُحسب بالسعر بعد الخصم لا قبله', () => {
    const lines = applyBasket(
      [
        promo({ id: 1, percent: 50, target: { kind: 'variant', id: 100 } }),
        promo({
          id: 2,
          kind: 'buy_x_get_y',
          percent: null,
          buyQty: 1,
          getQty: 1,
          target: { kind: 'variant', id: 100 },
        }),
      ],
      [item({ qty: 2 })],
      ctx,
    );
    const line = lines[0]!;
    expect(line.line.unitAfterSyp).toBe(500);
    // الهدية ٥٠٠ لا ١٠٠٠ — وإلا صار مجموع السطر صفراً بعد خصمٍ نصفه فقط.
    expect(line.free?.discountSyp).toBe(500);
    expect(line.lineTotalSyp).toBe(500);
  });

  it('مجموع السطر لا يصير سالباً أبداً', () => {
    const lines = applyBasket(
      [
        promo({
          id: 3,
          kind: 'buy_x_get_y',
          percent: null,
          buyQty: 1,
          getQty: 1,
          target: { kind: 'variant', id: 100 },
        }),
      ],
      [item({ qty: 2 })],
      ctx,
    );
    expect(lines[0]!.lineTotalSyp).toBeGreaterThanOrEqual(0);
    // وبلا أي عرض: المجموع هو السعر × الكمية بلا نقصان.
    const plain = applyBasket([], [item({ qty: 3 })], ctx);
    expect(plain[0]!.lineTotalSyp).toBe(3000);
    expect(plain[0]!.free).toBeNull();
  });
});

describe('السقف وحارس الخسارة', () => {
  it('السقف يُقاس بأعلى ما يفعله العرض لا بالحالة الشائعة', () => {
    expect(maxPercentOf(promo({ kind: 'percent', percent: 15 }), 1000)).toBe(15);
    expect(maxPercentOf(promo({ kind: 'amount', amountSyp: 250 }), 1000)).toBe(25);
    // شرائح: الكمية الكبيرة هي الفاتورة الكبيرة، فالسقف يُقاس بها.
    expect(
      maxPercentOf(
        promo({
          kind: 'qty_tiers',
          tiers: [
            { minQty: 5, percent: 10, amountSyp: null },
            { minQty: 50, percent: 40, amountSyp: null },
          ],
        }),
        1000,
      ),
    ).toBe(40);
    // «اشترِ ٣ خذ ١ مجاناً» = ٢٥٪ على المجموعة.
    expect(maxPercentOf(promo({ kind: 'buy_x_get_y', buyQty: 3, getQty: 1 }), 1000)).toBe(25);
  });

  it('السقف يقيّد الفرعي وحده', () => {
    expect(capApplies({ branchIds: [3] })).toBe(true);
    // والمركزي لا — وإلا احتاج كل عرض إدارة رفعَ السقف ثم إعادته.
    expect(capApplies({ branchIds: null })).toBe(false);
  });

  it('التكلفة الغائبة ليست خسارة، والمساوية ليست خسارة', () => {
    expect(
      lossWarningsFor([{ variantId: 1, priceAfterSyp: 400, avgCostSyp: 500 }]),
    ).toHaveLength(1);
    // صنفٌ لم يُستلم قط لا تكلفة له — ولوحةٌ تحذّر دائماً لا يقرؤها أحد.
    expect(lossWarningsFor([{ variantId: 1, priceAfterSyp: 400, avgCostSyp: null }])).toEqual([]);
    expect(lossWarningsFor([{ variantId: 1, priceAfterSyp: 400, avgCostSyp: 0 }])).toEqual([]);
    // البيع بالتكلفة بالضبط ليس خسارة.
    expect(lossWarningsFor([{ variantId: 1, priceAfterSyp: 500, avgCostSyp: 500 }])).toEqual([]);
    expect(lossWarningsFor([{ variantId: 1, priceAfterSyp: 600, avgCostSyp: 500 }])).toEqual([]);
  });
});
