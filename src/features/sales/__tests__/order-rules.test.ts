import { describe, expect, it } from 'vitest';
import {
  formatOrderNumber,
  hoursLeft,
  isOpen,
  isReservationLive,
  nextStates,
  reservationDeadline,
  validateCheckout,
  type CartLineInput,
} from '../services/order-rules.js';

/**
 * **كل جواب خاطئ هنا بضاعةٌ محجوزة لا يأتي صاحبها، أو زبونٌ يصل لرفٍّ فارغ
 * وبيده رقم طلب.**
 *
 * مهلةٌ تُقرأ «انتهت» تُلغي طلباً مؤكَّداً · وصفرٌ يُقرأ «تنتهي فوراً» يُلغي كل
 * طلب لحظة تأكيده · وسلّةٌ تمرّ بلا فحصٍ عند التأكيد تَعِد بآخر قطعة باعها
 * غيره · وحالةٌ نهائية تقبل خطوةً تالية تُسلّم البضاعة مرتين.
 *
 * ولذلك **كل حالة مع نقيضها**: إثبات أن المنتهية تُرفض لا يكفي وحده (دالّةٌ
 * ترفض كل شيء تنجح فيه، وهي متجرٌ لا يقبل طلباً أبداً).
 */

function line(over: Partial<CartLineInput> = {}): CartLineInput {
  return { variantId: 16, qty: 2, unitPriceSyp: 2500, availableQty: 5, ...over };
}

describe('آلة الحالات', () => {
  it('المفتوح وحده له خطوات، والنهائية لا تعود', () => {
    expect(nextStates('pending_pickup')).toEqual(['picked_up', 'cancelled', 'expired']);
    // الثلاث نهائية: خطوةٌ بعد التسليم تُسلّم البضاعة مرتين.
    expect(nextStates('picked_up')).toEqual([]);
    expect(nextStates('cancelled')).toEqual([]);
    expect(nextStates('expired')).toEqual([]);

    expect(isOpen('pending_pickup')).toBe(true);
    // **والمنتهية ليست ملغاة**: الأولى تقول إن الزبون لم يأتِ، والثانية إن
    // أحداً قرّر — وكلتاهما مغلقة، لكن جمعَهما يُخفي كم طلباً يضيع.
    expect(isOpen('expired')).toBe(false);
    expect(isOpen('cancelled')).toBe(false);
    expect(isOpen('picked_up')).toBe(false);
  });
});

describe('مهلة الحجز', () => {
  const at = new Date('2026-09-24T10:00:00Z');

  it('صفرٌ يعني بلا مهلة لا «تنتهي فوراً»', () => {
    // «تنتهي فوراً» تُلغي كل طلب لحظة تأكيده — وهي الفرق بين إعدادٍ لم يُملأ
    // وإعدادٍ يعطّل الميزة كلّها.
    expect(reservationDeadline(at, 0)).toBeNull();
    expect(reservationDeadline(at, -3)).toBeNull();
    expect(reservationDeadline(at, 48)?.toISOString()).toBe('2026-09-26T10:00:00.000Z');
  });

  it('الحيّ حيٌّ حتى لحظته، وبلا مهلة يبقى', () => {
    const until = new Date('2026-09-26T10:00:00Z');
    expect(isReservationLive(until, new Date('2026-09-26T09:59:00Z'))).toBe(true);
    expect(isReservationLive(until, until)).toBe(false);
    expect(isReservationLive(until, new Date('2026-09-26T10:01:00Z'))).toBe(false);
    // بلا مهلة: يبقى حتى يلغيه أحد — لا يُقرأ منتهياً بصمت.
    expect(isReservationLive(null, at)).toBe(true);
  });

  it('الباقي بالساعات يُقرَّب لأعلى ولا يصير سالباً', () => {
    const until = new Date('2026-09-24T16:30:00Z');
    // «يسقط خلال ٧ ساعات» أصدق من «٦٫٥» بشاشةٍ يقرؤها كاشير مستعجل.
    expect(hoursLeft(until, at)).toBe(7);
    expect(hoursLeft(until, new Date('2026-09-24T17:00:00Z'))).toBe(0);
    expect(hoursLeft(null, at)).toBeNull();
  });
});

describe('فحص التأكيد', () => {
  it('السلّة الفارغة لا تُؤكَّد', () => {
    expect(validateCheckout([])).toEqual({ kind: 'empty' });
  });

  it('غير المسعَّر يُرفض باسمه', () => {
    // «غير مسعَّر» عطلٌ عندنا — وتمريرُه يُنشئ طلباً بمبلغ صفر.
    const problem = validateCheckout([line({ unitPriceSyp: null })]);
    expect(problem?.kind).toBe('unpriced');
  });

  it('ما فوق المتاح يُرفض **بعدده**', () => {
    const problem = validateCheckout([line({ qty: 9, availableQty: 3 })]);
    expect(problem?.kind).toBe('not_enough');
    // الرقم يسافر مع الرفض: «غير متاح» بلا عددٍ يجعله يخفّض الكمية تخميناً.
    if (problem?.kind === 'not_enough') {
      expect(problem.available).toBe(3);
      expect(problem.requested).toBe(9);
    }
    // والمتاح سالباً (رصيد سالب) يُقرأ صفراً لا رقماً يُطرح منه.
    const negative = validateCheckout([line({ qty: 1, availableQty: -4 })]);
    if (negative?.kind === 'not_enough') expect(negative.available).toBe(0);
  });

  it('السلّة الصالحة تمرّ — والمتاح بالضبط يكفي', () => {
    // إثبات الرفض وحده لا يُثبت شيئاً: دالّةٌ ترفض كل شيء تنجح فيه.
    expect(validateCheckout([line()])).toBeNull();
    expect(validateCheckout([line({ qty: 5, availableQty: 5 })])).toBeNull();
    expect(validateCheckout([line(), line({ variantId: 17 })])).toBeNull();
  });
});

describe('رقم الطلب', () => {
  it('يحمل حرف O فلا يقطع ترقيم الفواتير ولا المرتجعات', () => {
    expect(formatOrderNumber('MZ', 2026, 1)).toBe('MZ-O-2026-000001');
    expect(formatOrderNumber('MZ', 2026, 1)).not.toBe('MZ-2026-000001');
    expect(formatOrderNumber('MZ', 2026, 1)).not.toBe('MZ-R-2026-000001');
    expect(formatOrderNumber('', 2026, 12)).toBe('SL-O-2026-000012');
  });
});
