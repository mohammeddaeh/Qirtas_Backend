/**
 * قواعد الطلب الإلكتروني — دالّات صافية، `orders_delivery.md` و
 * `inventory_suppliers.md` §٦.
 *
 * **كل جواب خاطئ هنا بضاعةٌ محجوزة لا يأتي صاحبها، أو زبونٌ يصل لرفٍّ فارغ
 * وبيده رقم طلب.** ولا شيء يفشل: الشاشة تعرض حالةً معقولة، والرفّ وحده يعرف.
 */

export type OrderStatus = 'pending_pickup' | 'picked_up' | 'cancelled' | 'expired';

/**
 * ما يمكن أن يصير إليه الطلب الآن.
 *
 * تُرسَل مع الردّ فتُبنى الأزرار منها (نفس قاعدة `next_states` بأمر النقل):
 * آلة حالاتٍ ثانية بالعميل تنحرف أول تعديل، وتعرض زرّاً يرفضه الخادم.
 */
export function nextStates(status: OrderStatus): OrderStatus[] {
  switch (status) {
    case 'pending_pickup':
      return ['picked_up', 'cancelled', 'expired'];
    // الثلاث نهائية: طلبٌ سُلِّم أو أُلغي أو انتهى لا يعود.
    case 'picked_up':
    case 'cancelled':
    case 'expired':
      return [];
  }
}

export function isOpen(status: OrderStatus): boolean {
  return status === 'pending_pickup';
}

/** هل ما زال الحجز قائماً. `null` = بلا مهلة، فيبقى حتى يلغيه أحد. */
export function isReservationLive(reservedUntil: Date | null, now: Date): boolean {
  if (reservedUntil === null) return true;
  return now.getTime() < reservedUntil.getTime();
}

/**
 * متى يسقط الحجز.
 *
 * **صفرٌ = بلا مهلة** لا «تنتهي فوراً»: الأولى قرارٌ إداري مفهوم، والثانية
 * تُلغي كل طلب لحظة تأكيده — وهي الفرق بين إعدادٍ لم يُملأ وإعدادٍ يعطّل
 * الميزة كلّها.
 */
export function reservationDeadline(confirmedAt: Date, hours: number): Date | null {
  if (hours <= 0) return null;
  return new Date(confirmedAt.getTime() + hours * 60 * 60 * 1000);
}

/** كم بقي بالساعات — به تُقال «يسقط خلال ٦ ساعات» بدل تاريخٍ يُحسب ذهنياً. */
export function hoursLeft(reservedUntil: Date | null, now: Date): number | null {
  if (reservedUntil === null) return null;
  const ms = reservedUntil.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / (60 * 60 * 1000));
}

export interface CartLineInput {
  variantId: number;
  qty: number;
  /** السعر بعد العرض — من منفذ التسعير، لا من الجهاز. */
  unitPriceSyp: number | null;
  /** المتاح بالفرع الآن (`on_hand − reserved`). */
  availableQty: number;
}

export type CheckoutProblem =
  | { kind: 'empty' }
  | { kind: 'unpriced'; variantId: number }
  | { kind: 'not_enough'; variantId: number; requested: number; available: number };

/**
 * هل تصلح هذه السلّة للتأكيد — **ويُعاد الفحص عند الدفع دائماً**.
 *
 * بين الإضافة والتأكيد قد يشتري غيرُه آخر قطعة، وقد يُسحب الصنف من التسعير.
 * فحصٌ عند الإضافة وحده يجعل الزبون يؤكّد طلباً لا يمكن تنفيذه، ويكتشف ذلك
 * حين يصل المحل.
 *
 * **والرفض يحمل العدد المتاح**: «غير متاح» بلا رقمٍ يجعله يخفّض الكمية تخميناً.
 */
export function validateCheckout(lines: CartLineInput[]): CheckoutProblem | null {
  if (lines.length === 0) return { kind: 'empty' };
  for (const line of lines) {
    if (line.unitPriceSyp === null) return { kind: 'unpriced', variantId: line.variantId };
    if (line.qty > line.availableQty) {
      return {
        kind: 'not_enough',
        variantId: line.variantId,
        requested: line.qty,
        available: Math.max(0, line.availableQty),
      };
    }
  }
  return null;
}

/**
 * `MZ-O-2026-000001` — **حرف `O` يفصل الطلبات عن الفواتير والمرتجعات**.
 *
 * ثلاثة تسلسلات لا واحد: رقمٌ مشترك يجعل ترقيم الفواتير مثقوباً بأرقام لم
 * تُصدَر لها فاتورة قط، والمدقّق يلاحق فجوةً لا وجود لها.
 */
export function formatOrderNumber(prefix: string, year: number, sequence: number): string {
  const clean = prefix.trim().toUpperCase().slice(0, 6) || 'SL';
  return `${clean}-O-${year}-${String(sequence).padStart(6, '0')}`;
}
