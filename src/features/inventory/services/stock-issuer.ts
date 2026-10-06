import { registerStockIssuer } from '../../../core/stock/stock-port.js';
import { registerConsumptionPoster } from '../../../core/stock/consumption-port.js';
import { postMovements } from './stock.service.js';

/**
 * The ledger's hand at the till, handed to the port.
 *
 * Registered by the composition root rather than imported by sales, so the
 * dependency runs one way: sales asks, inventory answers, neither imports the
 * other.
 *
 * **An issue never moves the weighted average** (§٣) — it carries the average
 * it left at, which is what lets a two-year-old sale still be valued without
 * replaying every receipt before it. That rule lives in `postMovements` and is
 * not restated here; a second copy would be the first thing to drift.
 */
export function installInventoryStockIssuer(): void {
  registerStockIssuer(({ exec, branchId, lines, docType, docId, userId }) =>
    postMovements(exec, {
      branchId,
      type: docType === 'sale' ? 'sale' : 'return_in',
      docType: docType === 'sale' ? null : 'return',
      docId,
      // البيع يُخرج، فالكمية سالبة هنا — والمنادي يرسل موجباً لأن «كم غادر»
      // سؤالٌ بجواب موجب، وترك الإشارة له يجعل خطأً بها يزيد المخزون ببيعة.
      lines: lines.map((line) => ({
        variantId: line.variantId,
        qtyBase: docType === 'sale' ? -Math.abs(line.qtyBase) : Math.abs(line.qtyBase),
        note: line.note ?? null,
      })),
      userId,
    }),
  );
}

/**
 * Production consumption (a print job's paper, ink, binding) — `production_consume`
 * movements pointing at the job. The consumer sends **used = positive**; the
 * ledger stores leaving as negative, so the sign flips here and nowhere else.
 * A negative consumption (a reconciliation returning over-estimated ink) goes
 * back at the current average, like a return.
 */
export function installInventoryConsumptionPoster(): void {
  registerConsumptionPoster(({ exec, branchId, lines, printJobId, printCounterId, userId }) =>
    postMovements(exec, {
      branchId,
      type: 'production_consume',
      docType: printJobId !== null ? 'print_job' : printCounterId ? 'print_counter' : null,
      docId: printJobId ?? printCounterId ?? null,
      lines: lines.map((line) => ({
        variantId: line.variantId,
        qtyBase: -line.qtyBase,
        note: line.note ?? null,
      })),
      userId,
    }),
  );
}
