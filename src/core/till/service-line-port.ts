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
  /** A name typed on the service, no account (9-ح-1) — names an unnamed invoice. */
  customerName?: string | null;
}

/**
 * What a sold service line can take back (`finance_ledger.md` §٣, M-2): how
 * many copies, and — when nothing can be returned — why, said before the
 * cashier types an amount.
 */
export interface ServiceReturnInfo {
  copies: number;
  label: string | null;
  returnable: boolean;
  /** Message key when not returnable (e.g. `print_job_not_printed`). */
  whyNot: string | null;
}

/** «ready» to the ready shelf · «damaged» a loss · «reprint» printed again, no refund. */
export type ServiceReturnDisposition = 'ready' | 'damaged' | 'reprint';

export interface ServiceReturnInput {
  refId: number;
  saleId: number;
  returnId: number;
  /** The branch taking the copies back — the shelf they go on. */
  branchId: number;
  copies: number;
  disposition: ServiceReturnDisposition;
  label: string | null;
  reasonCode: string | null;
  userId: number;
}

export interface ServiceLineHandler {
  kind: ServiceKind;
  /** Absent ⇒ the line is not returnable at all. */
  returnInfo?(refId: number): Promise<ServiceReturnInfo>;
  /**
   * The copies came back — **inside the till's return transaction**. The till
   * owns the refund; the service owns where the copies go and their value.
   */
  processReturn?(exec: ServiceExec, input: ServiceReturnInput): Promise<void>;
  resolve(input: {
    reference: string;
    branchId: number;
    saleId: number;
  }): Promise<ServiceLineQuote>;
  attach(exec: ServiceExec, refId: number, saleId: number): Promise<void>;
  detach(exec: ServiceExec, refId: number, saleId: number): Promise<void>;
  settle(exec: ServiceExec, refId: number, saleId: number, userId: number): Promise<void>;
}

/** `print_counter` — a print sold straight at the till, no order (slice 9-و). */
export const SERVICE_KINDS = ['print_job', 'print_counter', 'print_ready'] as const;
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

// ── Is the invoice holding a service being worked on? (tidy-up 2026-10-06) ──

/**
 * `active` — open and recent: a cashier may be taking the money right now ·
 * `idle` — held, or open and left for hours: nobody is at it · `gone` —
 * paid, voided, missing.
 */
export type TillSaleState = 'active' | 'idle' | 'gone';

export interface TillSaleAccess {
  state(saleId: number): Promise<TillSaleState>;
  /** Takes the service's line off that invoice and tells its owner (detach). */
  release(kind: ServiceKind, refId: number, saleId: number): Promise<void>;
}

let tillAccess: TillSaleAccess | undefined;

/** Installed by `buildApp()` from the sales feature — services never import it. */
export function setTillSaleAccess(value: TillSaleAccess): void {
  tillAccess = value;
}

export function tillSale(): TillSaleAccess {
  if (!tillAccess) throw new Error('Till sale access not configured — call setTillSaleAccess() in buildApp()');
  return tillAccess;
}
