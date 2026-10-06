import type { StockExec } from './stock-port.js';

/**
 * "These materials were used to produce something, in my transaction" — asked
 * by printing when a job starts (slice 9-هـ, `printing_system.md` §خطة 9-هـ).
 *
 * The same one-way dependency as the till's `issueStock`: printing knows what a
 * job consumed, inventory owns the ledger, neither imports the other.
 *
 * `qtyBase` is **signed from the consumer's side**: positive = used up (leaves
 * the shelf), negative = handed back (an ink reconciliation found the estimate
 * too high). The port turns that into ledger signs — a consumer that had to
 * know the ledger's convention would get it backwards once, and stock would
 * grow with every job.
 */
export interface ConsumptionLine {
  variantId: number;
  qtyBase: number;
  note?: string | null;
}

export interface ConsumptionRequest {
  exec: StockExec;
  branchId: number;
  lines: ConsumptionLine[];
  /** The print job the materials went into; `null` for a reconciliation. */
  printJobId: number | null;
  /** A print sold straight at the till (slice 9-و) — instead of a job. */
  printCounterId?: number | null;
  userId: number;
}

export type ConsumptionPoster = (request: ConsumptionRequest) => Promise<void>;

let poster: ConsumptionPoster | null = null;

export function registerConsumptionPoster(fn: ConsumptionPoster): void {
  poster = fn;
}

/** Test seam — module state, and a test that swaps the poster must restore it. */
export function clearConsumptionPoster(): void {
  poster = null;
}

/**
 * **Throws when unwired** — a job that started printing with no movement for
 * its paper leaves the shelf count above reality with nothing failing.
 */
export async function postConsumption(request: ConsumptionRequest): Promise<void> {
  if (poster === null) {
    throw new Error(
      'Consumption poster not configured — call installInventoryConsumptionPoster() in buildApp()',
    );
  }
  const lines = request.lines.filter((l) => l.qtyBase !== 0);
  if (lines.length === 0) return;
  return poster({ ...request, lines });
}
