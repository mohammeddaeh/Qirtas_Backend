import type { db } from '../db/client.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ServiceExec = typeof db | Tx;

/**
 * A line on a till invoice that is **not goods** — «خدمة طباعة» today,
 * customization later (decided 2026-09-28: a print order is paid as a line on
 * the POS invoice — one drawer, one invoice number, one report).
 *
 * The till owns the money; the feature that sold the service owns what the
 * money settles. Neither imports the other (`features/CLAUDE.md`), so the
 * feature registers a handler here and the till calls it — at the same four
 * moments an order pickup has, **each inside the till's own transaction** where
 * it matters:
 *
 * - `resolve` — the cashier typed a reference. Is it payable here, for how
 *   much? The amount comes from the service, never from the device.
 * - `attach` — the line was added. The service stops its own clock (a job does
 *   not expire while its customer stands at the counter).
 * - `detach` — the line was removed or the basket voided. The clock restarts.
 * - `settle` — the invoice was paid. **Same transaction as the payment**: a
 *   paid invoice whose print job still says «unpaid» is the drawer and the
 *   production queue disagreeing, with nothing failing.
 */
export interface ServiceLineQuote {
  /** The service row the line stands for (a print job id). */
  refId: number;
  nameAr: string;
  /** Printed on the receipt where a product shows its SKU — the job number. */
  sku: string;
  amountSyp: number;
  taxPercent: number;
  /** Whose service this is — the invoice is put in their name when it has none. */
  customerId: number | null;
}

export interface ServiceLineHandler {
  kind: ServiceKind;
  resolve(input: {
    reference: string;
    branchId: number;
    saleId: number;
  }): Promise<ServiceLineQuote>;
  attach(exec: ServiceExec, refId: number, saleId: number): Promise<void>;
  detach(exec: ServiceExec, refId: number, saleId: number): Promise<void>;
  settle(exec: ServiceExec, refId: number, saleId: number, userId: number): Promise<void>;
}

export const SERVICE_KINDS = ['print_job'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

const handlers = new Map<ServiceKind, ServiceLineHandler>();

export function registerServiceLineHandler(handler: ServiceLineHandler): void {
  handlers.set(handler.kind, handler);
}

/** Test seam — module state, and a test that swaps a handler must restore it. */
export function clearServiceLineHandlers(): void {
  handlers.clear();
}

/**
 * **Throws when unwired**: a service line whose handler is missing would be
 * paid without its service ever hearing of it — money in the drawer, a job
 * still waiting for payment.
 */
export function serviceLineHandler(kind: ServiceKind): ServiceLineHandler {
  const handler = handlers.get(kind);
  if (!handler) throw new Error(`No service line handler for "${kind}" — install it in buildApp()`);
  return handler;
}
