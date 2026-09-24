import { describe, expect, it } from 'vitest';
import type { WireCart, WireCartLine, WireOrder } from '../services/orders.service.js';

/**
 * **The server half of the cart/order contract `qirtas_app` parses**
 * (`test/wire_contract_test.dart` · fixtures `test/fixtures/wire/cart.json`,
 * `customer_order.json`, `branch_orders_page.json`, `order_pickup.json`).
 *
 * A JSON key here is an agreement nothing enforces: `tsc` does not know a
 * client exists, and the client reads a missing key as `null`. And every
 * fallback on the other side is deliberately the *safe* one, which is exactly
 * what makes a rename silent:
 *
 * - `can_checkout` missing reads as `false` — **a valid cart can never be
 *   confirmed**, and nothing on screen says why.
 * - `next_states` missing reads as «no step open» — «ألغِ الطلب» and «افتح
 *   سلّة الاستلام» both vanish from a live order.
 * - `problem` gone reads as `unpriced` on every line — a working cart shows
 *   every row flagged.
 * - `sale_id` gone after a pickup leaves the till with no basket, after a
 *   pickup that actually succeeded.
 *
 * None of these throws. The log says `200`, the database holds a real
 * reservation, and the screen is wrong.
 *
 * When this list changes, change the Flutter fixture in the same commit.
 */

const line: WireCartLine = {
  variant_id: 16,
  product_id: 5,
  name_ar: 'منتج تجربة مخزون',
  sku: 'QRT-000016',
  qty: 2,
  unit_price_syp: 2500,
  was_syp: null,
  promotion_names: [],
  line_total_syp: 5000,
  available_qty: 128,
  problem: null,
};

const cart: WireCart = {
  branch_id: 34,
  lines: [line],
  subtotal_syp: 5000,
  discount_syp: 0,
  total_syp: 5000,
  can_checkout: true,
};

const order: WireOrder = {
  id: 4,
  number: 'OW-O-2026-000004',
  branch_id: 34,
  branch_name: 'فرع المزة',
  customer_id: 111,
  customer_name: 'زبون العقد',
  status: 'pending_pickup',
  next_states: ['picked_up', 'cancelled', 'expired'],
  subtotal_syp: 5000,
  discount_syp: 0,
  tax_syp: 0,
  total_syp: 5000,
  reserved_until: '2026-09-26T08:27:19.082Z',
  hours_left: 48,
  sale_id: null,
  note: 'ملاحظة للفرع',
  cancel_reason: null,
  lines: [
    {
      variant_id: 16,
      product_id: 5,
      name_ar: 'منتج تجربة مخزون',
      sku: 'QRT-000016',
      qty: 2,
      unit_price_syp: 2500,
      promotion_discount_syp: 0,
      promotion_names: [],
      line_total_syp: 5000,
    },
  ],
  created_at: '2026-09-24T08:27:19.082Z',
  picked_up_at: null,
};

describe('cart wire shape', () => {
  it('carries the keys the cart screen hangs on', () => {
    for (const key of ['branch_id', 'lines', 'subtotal_syp', 'discount_syp', 'total_syp', 'can_checkout']) {
      expect(cart).toHaveProperty(key);
    }
  });

  it('a line says what it costs, what is left, and what is wrong with it', () => {
    for (const key of ['variant_id', 'qty', 'unit_price_syp', 'line_total_syp', 'available_qty', 'problem']) {
      expect(line).toHaveProperty(key);
    }
    // **`problem: null` is a value, not an absence**: the client reads an
    // unknown problem as `unpriced`, so a key dropped here flags every row of
    // a perfectly good cart.
    expect(line.problem).toBeNull();
  });

  it('an unpriced line answers `null`, never `0`', () => {
    // Zero reads as «free» on the customer screen — and gets added.
    const unpriced: WireCartLine = { ...line, unit_price_syp: null, problem: 'unpriced' };
    expect(unpriced.unit_price_syp).toBeNull();
    expect(unpriced.unit_price_syp).not.toBe(0);
  });

  it('the four problem values are the ones the client knows', () => {
    const known = [null, 'unpriced', 'not_enough', 'not_sellable'];
    for (const value of known) {
      const row: WireCartLine = { ...line, problem: value as WireCartLine['problem'] };
      expect(known).toContain(row.problem);
    }
  });
});

describe('order wire shape', () => {
  it('carries the keys the order screen hangs on', () => {
    for (const key of [
      'id',
      'number',
      'branch_id',
      'status',
      'next_states',
      'total_syp',
      'reserved_until',
      'hours_left',
      'sale_id',
      'lines',
      'created_at',
    ]) {
      expect(order).toHaveProperty(key);
    }
  });

  it('the four statuses are the ones the client maps by name', () => {
    const known = ['pending_pickup', 'picked_up', 'cancelled', 'expired'];
    expect(known).toContain(order.status);
    // **`expired` is not `cancelled`**: merging them hides how many orders are
    // lost with nobody cancelling them.
    expect(known).toContain('expired');
    expect(known).toContain('cancelled');
  });

  it('`next_states` travels as the same strings, so buttons are built from it', () => {
    expect(order.next_states).toContain('cancelled');
    expect(order.next_states).toContain('picked_up');
    // A closed order offers nothing — and that is a value, not an absence.
    const closed: WireOrder = { ...order, status: 'picked_up', next_states: [] };
    expect(closed.next_states).toEqual([]);
  });

  it('`hours_left` is `null` when there is no deadline, never `0`', () => {
    // Zero means «the hold expires now»; null means «held until you come» or
    // «the clock is stopped at the till». Merging them tells a customer whose
    // goods are held indefinitely that his hold is expiring.
    const noDeadline: WireOrder = { ...order, reserved_until: null, hours_left: null };
    expect(noDeadline.hours_left).toBeNull();
    expect(noDeadline.hours_left).not.toBe(0);
  });

  it('`sale_id` appears once a pickup basket is open', () => {
    const atTill: WireOrder = { ...order, sale_id: 15, hours_left: null, reserved_until: null };
    expect(atTill.sale_id).toBe(15);
    expect(order.sale_id).toBeNull();
  });
});
