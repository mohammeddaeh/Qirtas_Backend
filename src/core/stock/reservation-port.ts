import type { StockExec } from './stock-port.js';

/**
 * "Hold these for a confirmed order" — asked from the order path.
 *
 * A reservation is not a movement: the goods stay on the shelf and in the
 * ledger, but the till may no longer sell them (`inventory_suppliers.md` §٦).
 * That distinction lives in `stock_balances.reserved`, which inventory owns,
 * and orders may not import inventory (`features/CLAUDE.md`).
 *
 * **The check and the write are one step.** Reading "available" and then
 * writing a reservation lets two customers confirm the last piece: both read
 * 1, both write, and one of them is promised goods that are not there. The
 * implementation locks the balance row, so the second caller sees the first
 * one's hold.
 */
export interface ReservationLine {
  variantId: number;
  /** Base units to hold — **positive**. */
  qtyBase: number;
}

export interface ReservationRequest {
  exec: StockExec;
  branchId: number;
  lines: ReservationLine[];
}

/** Which variant could not be held, and how much was actually free. */
export interface ReservationShortfall {
  variantId: number;
  requested: number;
  available: number;
}

export type Reserver = (request: ReservationRequest) => Promise<ReservationShortfall[]>;
export type Releaser = (request: ReservationRequest) => Promise<void>;

let reserver: Reserver | null = null;
let releaser: Releaser | null = null;

export function registerReservation(reserve: Reserver, release: Releaser): void {
  reserver = reserve;
  releaser = release;
}

/** Test seam — module state, and a test that swaps these must restore them. */
export function clearReservation(): void {
  reserver = null;
  releaser = null;
}

/**
 * Holds the goods. Returns **what could not be held** — an empty array means
 * everything was reserved.
 *
 * **Throws when unwired**, like `issueStock`: a silent skip would confirm an
 * order against stock nobody is holding, and the customer arrives to an empty
 * shelf with an order number in hand.
 */
export async function reserveStock(request: ReservationRequest): Promise<ReservationShortfall[]> {
  if (reserver === null) {
    throw new Error('Reserver not configured — call installInventoryReservation() in buildApp()');
  }
  if (request.lines.length === 0) return [];
  return reserver(request);
}

/**
 * Frees a hold — on cancellation, on expiry, and after the goods are handed
 * over (the sale itself removes them from `on_hand`).
 *
 * **Never throws on an over-release**: the implementation floors at zero.
 * A reservation released twice is a bug worth fixing, but a crash here would
 * leave the order half-cancelled — the worse of the two outcomes.
 */
export async function releaseStock(request: ReservationRequest): Promise<void> {
  if (releaser === null) {
    throw new Error('Releaser not configured — call installInventoryReservation() in buildApp()');
  }
  if (request.lines.length === 0) return;
  return releaser(request);
}
