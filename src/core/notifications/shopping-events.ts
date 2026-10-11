import type { Lang } from '../i18n/messages.js';

/**
 * What happened to something a **customer** is waiting for — goods they asked
 * to be told about, a print order they sent. Not a decision about their
 * account (`events.ts`) and not staff work (`work-events.ts`).
 *
 * Push only, never email (2026-10-07): the answer is «come and get it» or «pay
 * now», which is worth something within the hour and nothing in an inbox the
 * next day. The app shows the same state on the order itself, so a push that
 * never lands loses no information — only the nudge.
 */
export const SHOPPING_NOTIFICATION = {
  backInStock: 'back_in_stock',
  printOrderPriced: 'print_order_priced',
  printOrderReady: 'print_order_ready',
  printOrderRejected: 'print_order_rejected',
} as const;

export type ShoppingNotificationEvent = (typeof SHOPPING_NOTIFICATION)[keyof typeof SHOPPING_NOTIFICATION];

export interface ShoppingNotificationParams {
  /** The product's name in each language — the device picks its own. */
  productAr?: string | null | undefined;
  productEn?: string | null | undefined;
  /** The branch where it is now on the shelf / where the order is collected. */
  branch?: string | null | undefined;
  /** The order number the customer sees. */
  number?: string | null | undefined;
  /** The amount to pay, already formatted by the server. */
  amountSyp?: number | null | undefined;
  /** Hours left to pay before the order lapses. */
  hoursLeft?: number | null | undefined;
  /** What the customer gives the cashier (`1005-042`). */
  pickupCode?: string | null | undefined;
  /** The branch's stated reason — theirs to read. */
  reason?: string | null | undefined;
}

interface Text {
  title: string;
  body: string;
}

/** Left-to-right isolate and its closing mark (U+2066 · U+2069). */
const LRI = String.fromCodePoint(0x2066);
const PDI = String.fromCodePoint(0x2069);

/**
 * A code or number inside an Arabic sentence, isolated left-to-right: `1007-002`
 * otherwise reads `002-1007` in the notification — the one thing the customer
 * says at the counter, reversed (seen on a phone 2026-10-07).
 */
const ltr = (v: string | null | undefined): string | null =>
  v === null || v === undefined || v === '' ? null : LRI + v + PDI;

const line = (...parts: (string | null | undefined)[]): string => parts.filter((p) => p && p.trim()).join(' · ');
const money = (n: number | null | undefined, unit: string): string | null =>
  n === null || n === undefined ? null : `${n.toLocaleString('en-US')} ${unit}`;

const TEXT: Record<ShoppingNotificationEvent, Record<Lang, (p: ShoppingNotificationParams) => Text>> = {
  back_in_stock: {
    ar: (p) => ({
      title: 'توفّر ما طلبته',
      body: line(p.productAr ?? p.productEn, p.branch ? `متوفّر الآن بفرع ${p.branch}` : 'متوفّر الآن'),
    }),
    en: (p) => ({
      title: 'Back in stock',
      body: line(p.productEn ?? p.productAr, p.branch ? `Now available at ${p.branch}` : 'Now available'),
    }),
  },
  print_order_priced: {
    ar: (p) => ({
      title: 'سُعِّر طلب الطباعة',
      body: line(
        ltr(p.number),
        money(p.amountSyp, 'ل.س'),
        p.hoursLeft === null || p.hoursLeft === undefined ? null : `ادفع خلال ${p.hoursLeft} ساعة`,
      ),
    }),
    en: (p) => ({
      title: 'Your print order is priced',
      body: line(
        ltr(p.number),
        money(p.amountSyp, 'SYP'),
        p.hoursLeft === null || p.hoursLeft === undefined ? null : `Pay within ${p.hoursLeft} h`,
      ),
    }),
  },
  print_order_ready: {
    ar: (p) => ({
      title: 'طباعتك جاهزة',
      body: line(p.pickupCode ? `رقم الاستلام ${ltr(p.pickupCode)}` : ltr(p.number), p.branch ? `استلمها من ${p.branch}` : null),
    }),
    en: (p) => ({
      title: 'Your print is ready',
      body: line(p.pickupCode ? `Pickup code ${ltr(p.pickupCode)}` : ltr(p.number), p.branch ? `Collect it at ${p.branch}` : null),
    }),
  },
  print_order_rejected: {
    ar: (p) => ({ title: 'تعذّر تنفيذ طلب الطباعة', body: line(ltr(p.number), p.reason ? `السبب: ${p.reason}` : null) }),
    en: (p) => ({ title: 'Your print order was declined', body: line(ltr(p.number), p.reason ? `Reason: ${p.reason}` : null) }),
  },
};

export function shoppingNotificationText(
  event: ShoppingNotificationEvent,
  lang: Lang,
  params: ShoppingNotificationParams,
): Text {
  return TEXT[event][lang](params);
}
