import type { db } from '../db/client.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * "Take these off the shelf, in my transaction" — asked from the till.
 *
 * A sale is two writes that must both happen or neither: the invoice and the
 * stock that left with it. Posting the movement in a second transaction means
 * a crash between them leaves an invoice for goods still on the books, or
 * goods gone with nothing that says why — and the ledger stops being
 * rebuildable, which is the one property it exists for.
 *
 * So the caller's transaction handle travels with the request. The inventory
 * module owns the locking, the weighted average and the append-only ledger
 * (`inventory_suppliers.md` §٢–§٣); sales owns the money. Neither imports the
 * other (`features/CLAUDE.md`).
 */
export type StockExec = typeof db | Tx;

export interface StockIssueLine {
  variantId: number;
  /** Base units leaving the shelf — **positive**; the port negates it. */
  qtyBase: number;
  note?: string | null;
}

export interface StockIssueRequest {
  exec: StockExec;
  branchId: number;
  lines: StockIssueLine[];
  /** The document the movement points back at, so «لماذا نقص ٣؟» has an answer. */
  docType: 'sale' | 'return';
  docId: number;
  userId: number;
}

export type StockIssuer = (request: StockIssueRequest) => Promise<void>;

let issuer: StockIssuer | null = null;

export function registerStockIssuer(fn: StockIssuer): void {
  issuer = fn;
}

/** Test seam — module state, and a test that swaps the issuer must restore it. */
export function clearStockIssuer(): void {
  issuer = null;
}

/**
 * Moves the goods. **Throws when unwired** — unlike the read-only ports, a
 * missing issuer here is not "no opinion": it is an invoice whose goods never
 * left the books, and a silent skip would make every sale overstate stock
 * with nothing failing.
 */
export async function issueStock(request: StockIssueRequest): Promise<void> {
  if (issuer === null) {
    throw new Error('Stock issuer not configured — call installInventoryStockIssuer() in buildApp()');
  }
  if (request.lines.length === 0) return;
  return issuer(request);
}
