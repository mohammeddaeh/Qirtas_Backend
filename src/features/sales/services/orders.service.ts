import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { resolvePricesAt, type PriceContext } from '../../../core/pricing/price-port.js';
import { releaseStock, reserveStock } from '../../../core/stock/reservation-port.js';
import { SALES_AUDIT, saleTarget } from '../audit-actions.js';
import * as repo from '../repositories/orders.repository.js';
import type { Exec } from '../repositories/orders.repository.js';
import * as salesRepo from '../repositories/sales.repository.js';
import * as returnsRepo from '../repositories/returns.repository.js';
import type { OrderRow } from '../schemas/orders.schema.js';
import { branchPrefix, roundSyp } from './sale-rules.js';
import {
  formatOrderNumber,
  hoursLeft,
  isOpen,
  nextStates,
  reservationDeadline,
  validateCheckout,
  type CartLineInput,
  type CheckoutProblem,
  type OrderStatus,
} from './order-rules.js';

const num = (v: string | null): number => (v === null ? 0 : Number(v));

/**
 * ما يُسأل عنه منفذ السعر من الطلب: **القناة `online` دائماً**.
 *
 * السلّة تُملأ من المتجر، فالسعر الذي رآه الزبون هناك هو الذي يجب أن يَعِد به
 * الطلب. قناةٌ أخرى هنا تجعل شاشة المراجعة تعرض رقماً غير الذي على البطاقة.
 */
const onlinePrices = (isWholesale: boolean): PriceContext => ({
  promotions: 'apply',
  channel: 'online',
  segment: isWholesale ? 'wholesale' : 'retail',
});

// ── السلّة ──────────────────────────────────────────────────────────────────

export interface WireCartLine {
  variant_id: number;
  product_id: number;
  name_ar: string;
  sku: string;
  qty: number;
  unit_price_syp: number | null;
  was_syp: number | null;
  promotion_names: string[];
  line_total_syp: number;
  /** المتاح الآن بهذا الفرع — به تُقال «بقي ٢» قبل أن يؤكّد. */
  available_qty: number;
  /** لماذا لا يمكن تأكيد هذا السطر، أو `null` حين يصلح. */
  problem: 'unpriced' | 'not_enough' | 'not_sellable' | null;
}

export interface WireCart {
  branch_id: number;
  lines: WireCartLine[];
  subtotal_syp: number;
  discount_syp: number;
  total_syp: number;
  /** هل تصلح كلها للتأكيد — الزر يتبعه ولا يُشتقّ بالعميل من الأسطر. */
  can_checkout: boolean;
}

interface PricedLine {
  wire: WireCartLine;
  rule: CartLineInput;
  taxPercent: number;
  promotionDiscountSyp: number;
}

/**
 * يقرأ السلّة بسعرها وتوفّرها **الآن**.
 *
 * ولا شيء منها مخزَّن: سعرٌ محفوظ بالسطر يُري الزبون ثمن الأسبوع الماضي، وكميةٌ
 * متاحة محفوظة تَعِده بآخر قطعة باعها غيره. السلّة **لا تحجز** (`inventory_suppliers.md`
 * §٦) — سلاتٌ متروكة تجمّد المخزون، فيقرأ الكاشير رفّاً ممتلئاً ولا يبيع منه.
 */
async function priceCart(
  branchId: number,
  isWholesale: boolean,
  lines: Awaited<ReturnType<typeof repo.findCartLines>>,
): Promise<PricedLine[]> {
  if (lines.length === 0) return [];
  const variantIds = lines.map((l) => l.variant_id);
  const [prices, available] = await Promise.all([
    resolvePricesAt(branchId, variantIds, onlinePrices(isWholesale)),
    repo.findAvailable(branchId, variantIds),
  ]);

  return lines.map((line) => {
    const qty = num(line.qty);
    const price = prices.get(line.variant_id);
    const priced = price?.status === 'priced' && price.amountSyp !== null ? price : null;
    const availableQty = available.get(line.variant_id) ?? 0;
    const unit = priced?.amountSyp ?? null;

    let problem: WireCartLine['problem'] = null;
    if (line.status !== 'active') problem = 'not_sellable';
    else if (unit === null) problem = 'unpriced';
    else if (qty > availableQty) problem = 'not_enough';

    const before = priced?.promotion?.beforeSyp ?? null;
    return {
      wire: {
        variant_id: line.variant_id,
        product_id: line.product_id,
        name_ar: line.name_ar,
        sku: line.sku,
        qty,
        unit_price_syp: unit,
        was_syp: before,
        promotion_names: priced?.promotion?.names ?? [],
        line_total_syp: roundSyp((unit ?? 0) * qty),
        available_qty: Math.max(0, availableQty),
        problem,
      },
      rule: {
        variantId: line.variant_id,
        qty,
        // الصنف الموقوف عن البيع يُعامَل كغير مسعَّر عند التأكيد: كلاهما
        // «لا يمكن أن يُسلَّم»، والفرق يُقال بالسطر لا بالرفض.
        unitPriceSyp: line.status === 'active' ? unit : null,
        availableQty,
      },
      taxPercent: priced?.taxPercent ?? 0,
      promotionDiscountSyp: before === null ? 0 : roundSyp(Math.max(0, before - (unit ?? 0)) * qty),
    };
  });
}

export async function getCart(customerId: number, branchId: number): Promise<WireCart> {
  const customer = await repo.findCustomer(customerId);
  const cart = await repo.findOrCreateCart(customerId, branchId);
  const rows = await repo.findCartLines(cart.id);
  const priced = await priceCart(branchId, customer?.is_wholesale ?? false, rows);

  const subtotal = priced.reduce(
    (sum, l) => sum + (l.wire.was_syp ?? l.wire.unit_price_syp ?? 0) * l.wire.qty,
    0,
  );
  const discount = priced.reduce((sum, l) => sum + l.promotionDiscountSyp, 0);
  return {
    branch_id: branchId,
    lines: priced.map((l) => l.wire),
    subtotal_syp: roundSyp(subtotal),
    discount_syp: roundSyp(discount),
    total_syp: roundSyp(priced.reduce((sum, l) => sum + l.wire.line_total_syp, 0)),
    can_checkout: priced.length > 0 && priced.every((l) => l.wire.problem === null),
  };
}

export async function addToCart(
  customerId: number,
  branchId: number,
  input: { variant_id: number; qty: number },
): Promise<WireCart> {
  if (input.qty <= 0) {
    throw new BusinessError(422, 'A cart line needs a quantity', 'cart_qty_required');
  }
  const branch = await repo.findShoppableBranch(branchId);
  if (!branch) {
    throw new BusinessError(404, 'This branch is not open for shopping', 'branch_not_shoppable');
  }
  const cart = await repo.findOrCreateCart(customerId, branchId);
  await repo.upsertCartLine(cart.id, input.variant_id, input.qty);
  return getCart(customerId, branchId);
}

export async function setCartQty(
  customerId: number,
  branchId: number,
  input: { variant_id: number; qty: number },
): Promise<WireCart> {
  const cart = await repo.findOrCreateCart(customerId, branchId);
  // كميةٌ صفر **تحذف السطر**: سطرٌ بصفر يبقى بالمراجعة ويُقرأ «طلبته ولم يصل».
  if (input.qty <= 0) await repo.deleteCartLine(cart.id, input.variant_id);
  else await repo.setCartLineQty(cart.id, input.variant_id, input.qty);
  return getCart(customerId, branchId);
}

export async function removeFromCart(
  customerId: number,
  branchId: number,
  variantId: number,
): Promise<WireCart> {
  const cart = await repo.findOrCreateCart(customerId, branchId);
  await repo.deleteCartLine(cart.id, variantId);
  return getCart(customerId, branchId);
}

// ── الطلب ───────────────────────────────────────────────────────────────────

export interface WireOrderLine {
  variant_id: number;
  product_id: number;
  name_ar: string;
  sku: string;
  qty: number;
  unit_price_syp: number;
  promotion_discount_syp: number;
  promotion_names: string[];
  line_total_syp: number;
}

export interface WireOrder {
  id: number;
  number: string;
  branch_id: number;
  branch_name: string | null;
  customer_id: number;
  customer_name: string | null;
  status: OrderStatus;
  /** الخطوات المفتوحة — الأزرار تُبنى منها لا من آلة حالات ثانية بالعميل. */
  next_states: OrderStatus[];
  subtotal_syp: number;
  discount_syp: number;
  tax_syp: number;
  total_syp: number;
  reserved_until: string | null;
  /** كم بقي — «يسقط خلال ٦ ساعات» أصدق من تاريخٍ يُحسب ذهنياً. */
  hours_left: number | null;
  sale_id: number | null;
  note: string | null;
  cancel_reason: string | null;
  lines: WireOrderLine[];
  created_at: string;
  picked_up_at: string | null;
}

async function wireOrder(row: OrderRow): Promise<WireOrder> {
  const [lines, branch, customer] = await Promise.all([
    repo.findOrderLines(row.id),
    salesRepo.findBranch(row.branch_id),
    repo.findCustomer(row.customer_id),
  ]);
  const now = new Date();
  return {
    id: row.id,
    number: row.number,
    branch_id: row.branch_id,
    branch_name: branch?.name ?? null,
    customer_id: row.customer_id,
    customer_name: customer?.name ?? null,
    status: row.status,
    next_states: nextStates(row.status),
    subtotal_syp: num(row.subtotal_syp),
    discount_syp: num(row.discount_syp),
    tax_syp: num(row.tax_syp),
    total_syp: num(row.total_syp),
    reserved_until: row.reserved_until?.toISOString() ?? null,
    // المغلق لا «يسقط بعد ساعتين»: ساعاتٌ باقية على طلبٍ سُلِّم تُقرأ مهلةً حيّة.
    hours_left: isOpen(row.status) ? hoursLeft(row.reserved_until, now) : null,
    sale_id: row.sale_id,
    note: row.note,
    cancel_reason: row.cancel_reason,
    lines: lines.map((line) => ({
      variant_id: line.variant_id,
      product_id: line.product_id,
      name_ar: line.name_ar,
      sku: line.sku,
      qty: num(line.qty),
      unit_price_syp: num(line.unit_price_syp),
      promotion_discount_syp: num(line.promotion_discount_syp),
      promotion_names: line.promotion_names === null ? [] : line.promotion_names.split(' · '),
      line_total_syp: num(line.line_total_syp),
    })),
    created_at: row.created_at.toISOString(),
    picked_up_at: row.picked_up_at?.toISOString() ?? null,
  };
}

export async function getOrder(id: number): Promise<WireOrder> {
  await sweepExpired();
  const row = await repo.findOrderById(id);
  if (!row) throw new NotFoundError('Order not found');
  return wireOrder(row);
}

export async function listOrders(
  filters: { branchId?: number; customerId?: number; status?: OrderStatus },
  limit: number,
  offset: number,
): Promise<{ items: WireOrder[]; total: number }> {
  await sweepExpired();
  const { rows, total } = await repo.findOrders(filters, limit, offset);
  return { items: await Promise.all(rows.map(wireOrder)), total };
}

/**
 * يؤكّد السلّة: يصرف الرقم · يجمّد المجاميع · **يحجز البضاعة** — بمعاملة واحدة.
 *
 * الحجز هو ما يجعل الطلب وعداً يمكن الوفاء به: بينه وبين وصول الزبون يقف
 * الكاشير على نفس الرفّ. وفصلُه عن إنشاء الطلب يترك طلباً بلا بضاعة محجوزة،
 * ولا شيء يقول ذلك حتى يصل صاحبه.
 *
 * **والفحص يُعاد داخل القفل**: بين قراءة المتاح وكتابة الحجز قد يشتري غيره آخر
 * قطعة — والقفل وحده يمنع أن يُوعَد اثنان بها.
 */
export async function checkout(
  customerId: number,
  branchId: number,
  input: { note?: string | null },
): Promise<WireOrder> {
  const [customer, branch] = await Promise.all([
    repo.findCustomer(customerId),
    repo.findShoppableBranch(branchId),
  ]);
  if (!customer) throw new NotFoundError('Customer not found');
  if (customer.status !== 'active') {
    throw new BusinessError(403, 'This account cannot order', 'order_account_not_active');
  }
  if (!branch) {
    throw new BusinessError(404, 'This branch is not open for shopping', 'branch_not_shoppable');
  }

  const cart = await repo.findOrCreateCart(customerId, branchId);
  const rows = await repo.findCartLines(cart.id);
  const priced = await priceCart(branchId, customer.is_wholesale, rows);

  const problem = validateCheckout(priced.map((l) => l.rule));
  if (problem !== null) refuseCheckout(problem);

  const settings = await returnsRepo.findSettings();
  const now = new Date();
  const year = now.getFullYear();
  const until = reservationDeadline(now, settings.reservation_hours);

  const subtotal = priced.reduce(
    (sum, l) => sum + (l.wire.was_syp ?? l.wire.unit_price_syp ?? 0) * l.wire.qty,
    0,
  );
  const discount = priced.reduce((sum, l) => sum + l.promotionDiscountSyp, 0);
  const total = priced.reduce((sum, l) => sum + l.wire.line_total_syp, 0);
  const tax = priced.reduce(
    (sum, l) => sum + (l.taxPercent > 0 ? (l.wire.line_total_syp * l.taxPercent) / (100 + l.taxPercent) : 0),
    0,
  );

  const orderId = await db.transaction(async (tx) => {
    const shortfalls = await reserveStock({
      exec: tx,
      branchId,
      lines: priced.map((l) => ({ variantId: l.wire.variant_id, qtyBase: l.wire.qty })),
    });
    if (shortfalls.length > 0) {
      const first = shortfalls[0]!;
      throw new BusinessError(409, 'Not enough stock to reserve', 'order_not_enough_stock', {
        variant_id: first.variantId,
        requested: first.requested,
        available: first.available,
      });
    }

    const sequence = await repo.nextOrderSequence(tx, branchId, year);
    const order = await repo.insertOrder(tx, {
      number: formatOrderNumber(branchPrefix(branch.name, branchId), year, sequence),
      sequence,
      branch_id: branchId,
      customer_id: customerId,
      status: 'pending_pickup',
      subtotal_syp: String(roundSyp(subtotal)),
      discount_syp: String(roundSyp(discount)),
      tax_syp: String(roundSyp(tax)),
      total_syp: String(roundSyp(total)),
      reserved_until: until,
      note: input.note?.trim() || null,
    });

    await repo.insertOrderLines(
      tx,
      priced.map((l) => ({
        order_id: order.id,
        variant_id: l.wire.variant_id,
        product_id: l.wire.product_id,
        name_ar: l.wire.name_ar,
        sku: l.wire.sku,
        qty: String(l.wire.qty),
        unit_price_syp: String(l.wire.was_syp ?? l.wire.unit_price_syp ?? 0),
        promotion_discount_syp: String(l.promotionDiscountSyp),
        promotion_names: l.wire.promotion_names.length === 0 ? null : l.wire.promotion_names.join(' · '),
        tax_percent: String(l.taxPercent),
        line_total_syp: String(l.wire.line_total_syp),
      })),
    );

    // **السلّة تُفرَّغ بنفس المعاملة**: سلّةٌ باقية بعد التأكيد تُؤكَّد مرة
    // ثانية فتحجز البضاعة مرتين.
    await repo.clearCart(tx, cart.id);
    return order.id;
  });

  return getOrder(orderId);
}

function refuseCheckout(problem: CheckoutProblem): never {
  if (problem.kind === 'empty') {
    throw new BusinessError(422, 'An empty cart cannot be confirmed', 'order_cart_empty');
  }
  if (problem.kind === 'unpriced') {
    // «غير مسعَّر» عطلٌ عندنا لا حقيقة عن البضاعة — ولا يُقال للزبون بهذه الكلمات.
    throw new BusinessError(409, 'An item in the cart is not available here', 'order_item_unavailable', {
      variant_id: problem.variantId,
    });
  }
  throw new BusinessError(409, 'Not enough stock for an item', 'order_not_enough_stock', {
    variant_id: problem.variantId,
    requested: problem.requested,
    available: problem.available,
  });
}

/** أسطر الطلب بوحدة الأساس — ما يُحجز وما يُحرَّر. */
async function reservationLinesOf(orderId: number) {
  const lines = await repo.findOrderLines(orderId);
  return lines.map((line) => ({ variantId: line.variant_id, qtyBase: num(line.qty) }));
}

/**
 * يُغلق طلباً مفتوحاً ويحرّر حجزه — **الاثنان بمعاملة واحدة**.
 *
 * حالةٌ تتغيّر بلا تحرير تترك بضاعةً محجوزة لطلبٍ ملغى، فيقرأ الكاشير رفّاً
 * ممتلئاً ويرفض الخادم بيعه — بلا ما يقول لماذا.
 */
async function closeOrder(
  orderId: number,
  status: 'cancelled' | 'expired',
  reason: string | null,
  userId: number | null,
): Promise<void> {
  const lines = await reservationLinesOf(orderId);
  await db.transaction(async (tx) => {
    const locked = await repo.lockOrder(tx, orderId);
    if (!locked) throw new NotFoundError('Order not found');
    // بين القراءة والقفل قد يكون الفرع سلّمه — والقفل هو ما يمنع تحرير حجزٍ
    // صار بيعاً، أي رفع `reserved` لصنفٍ غادر أصلاً.
    if (!isOpen(locked.status)) {
      throw new BusinessError(409, 'This order is already closed', 'order_not_open', {
        status: locked.status,
      });
    }
    await releaseStock({ exec: tx, branchId: locked.branch_id, lines });
    await repo.updateOrder(tx, orderId, {
      status,
      cancel_reason: reason,
      cancelled_by: userId,
      closed_at: new Date(),
    });
  });
}

export async function cancelOrder(
  orderId: number,
  input: { reason?: string | null; customerId?: number | null; userId?: number | null },
): Promise<WireOrder> {
  const row = await repo.findOrderById(orderId);
  if (!row) throw new NotFoundError('Order not found');
  // الزبون يلغي **طلبه هو**: معرّفٌ يصل بالمسار لا يكفي حارساً.
  if (input.customerId !== undefined && input.customerId !== null && row.customer_id !== input.customerId) {
    throw new NotFoundError('Order not found');
  }
  await closeOrder(orderId, 'cancelled', input.reason?.trim() || null, input.userId ?? null);
  return getOrder(orderId);
}

/**
 * يكنس ما سقطت مهلته — **كسلاً، بلا جدولة**.
 *
 * مهمّةٌ دورية كانت ستصير جزءاً ثانياً يجب أن يعمل ليكون الرقم صحيحاً؛ وإيقافها
 * يُجمّد المخزون لطلبات لا يأتي أصحابها بلا أي خطأ. والكنس عند القراءة يجعل من
 * ينظر للرقم هو من يصحّحه.
 */
export async function sweepExpired(): Promise<number> {
  const due = await repo.findExpiredOrders(new Date(), 50);
  let closed = 0;
  for (const order of due) {
    try {
      await closeOrder(order.id, 'expired', null, null);
      closed += 1;
    } catch {
      // سباقٌ مع تسليمٍ يجري الآن: الطلب أُغلق بطريق آخر، ولا شيء ليُصلَح.
    }
  }
  return closed;
}

/**
 * فتح سلّة الاستلام — **تُملأ من الطلب ولا تُسدَّد هنا**.
 *
 * السداد بالصندوق (قرار 2026-09-24): نسخةٌ ثانية من التسعير والدفع كانت
 * ستنحرف، والترقيم كان سيصير اثنين. فالطلب يصير سلّةً يفتحها الكاشير ويسدّدها
 * كأي بيع، والفاتورة واحدة.
 *
 * **والحجز يبقى قائماً، والمهلة تتوقّف** (`reserved_until = null`): الزبون واقفٌ
 * عند الصندوق، وكنسٌ يسقط عليه الآن يحرّر بضاعةً بيده. وتحريرُ الحجز هنا كان
 * سيجعل الصنف يظهر متاحاً وهو على الطاولة — فيَعِد به الخادمُ زبوناً آخر.
 */
export async function startPickup(
  actor: RequestActorContext,
  orderId: number,
): Promise<{ order: WireOrder; sale_id: number }> {
  const row = await repo.findOrderById(orderId);
  if (!row) throw new NotFoundError('Order not found');
  if (!isOpen(row.status)) {
    throw new BusinessError(409, 'This order is already closed', 'order_not_open', {
      status: row.status,
    });
  }
  if (row.sale_id !== null) {
    // فُتحت سلّته من قبل — تُعاد هي نفسها لا سلّةٌ ثانية بنفس البضاعة.
    return { order: await getOrder(orderId), sale_id: row.sale_id };
  }

  const lines = await repo.findOrderLines(orderId);

  const saleId = await db.transaction(async (tx) => {
    const locked = await repo.lockOrder(tx, orderId);
    if (!locked || !isOpen(locked.status)) {
      throw new BusinessError(409, 'This order is already closed', 'order_not_open');
    }
    if (locked.sale_id !== null) return locked.sale_id;

    const sale = await salesRepo.insertSale(
      {
        branch_id: locked.branch_id,
        cashier_user_id: actor.userId,
        customer_id: locked.customer_id,
      },
      tx,
    );

    for (const line of lines) {
      await salesRepo.insertLine(
        {
          sale_id: sale.id,
          variant_id: line.variant_id,
          product_id: line.product_id,
          name_ar: line.name_ar,
          sku: line.sku,
          unit_id: null,
          unit_factor: '1',
          qty: line.qty,
          // **السعر المجمَّد بالطلب هو ما يُسدَّد**: إعادة تسعيره عند الاستلام
          // تُري الزبون رقماً غير الذي وافق عليه، وعرضٌ انتهى بالأمس يرفع الفاتورة.
          unit_price_syp: line.unit_price_syp,
          promotion_discount_syp: line.promotion_discount_syp,
          promotion_names: line.promotion_names,
          tax_percent: line.tax_percent,
        },
        tx,
      );
    }

    await repo.updateOrder(tx, orderId, { sale_id: sale.id, reserved_until: null });
    return sale.id;
  });

  await recordAudit(actor, SALES_AUDIT.orderPickup, saleTarget.order(orderId), null, {
    sale_id: saleId,
  });
  return { order: await getOrder(orderId), sale_id: saleId };
}

/**
 * سُدِّدت فاتورة الاستلام — **يُقفل الطلب ويُحرَّر حجزه بنفس معاملة الدفع**.
 *
 * `paySale` تخصم `on_hand` هنا تماماً، فإبقاء الحجز بعدها يخصم البضاعة مرتين:
 * مرة من الرفّ ومرة من المتاح — فيكفّ الصنف عن الظهور للبيع وهو موجود. ولا
 * شيء يفشل: الرصيد صحيح والمتاح كاذب.
 */
export async function closePaidOrder(exec: Exec, saleId: number): Promise<void> {
  const order = await repo.findOrderBySaleId(saleId, exec);
  if (!order || !isOpen(order.status)) return;
  const lines = await repo.findOrderLines(order.id, exec);
  await releaseStock({
    exec,
    branchId: order.branch_id,
    lines: lines.map((line) => ({ variantId: line.variant_id, qtyBase: num(line.qty) })),
  });
  await repo.updateOrder(exec, order.id, {
    status: 'picked_up',
    picked_up_at: new Date(),
    closed_at: new Date(),
  });
}

/**
 * أُلغيت سلّة الاستلام — **الطلب يعود لانتظاره بمهلة جديدة**.
 *
 * الزبون غيّر رأيه عند الصندوق، أو أخطأ الكاشير السلّة. وترك الطلب مربوطاً
 * بفاتورة ملغاة يُجمّد بضاعته بلا مهلة تُسقطها أبداً — حجزٌ أبديّ لطلبٍ لن يأتي.
 */
export async function reopenVoidedOrder(exec: Exec, saleId: number): Promise<void> {
  const order = await repo.findOrderBySaleId(saleId, exec);
  if (!order || !isOpen(order.status)) return;
  const settings = await returnsRepo.findSettings();
  await repo.updateOrder(exec, order.id, {
    sale_id: null,
    reserved_until: reservationDeadline(new Date(), settings.reservation_hours),
  });
}
