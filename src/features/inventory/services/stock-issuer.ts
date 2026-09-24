import { registerStockIssuer } from '../../../core/stock/stock-port.js';
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
