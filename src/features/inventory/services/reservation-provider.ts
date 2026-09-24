import { sql } from 'drizzle-orm';
import {
  registerReservation,
  type ReservationRequest,
  type ReservationShortfall,
} from '../../../core/stock/reservation-port.js';
import { stockBalancesTable } from '../schemas/stock.schema.js';
import * as stockRepository from '../repositories/stock.repository.js';

/**
 * The ledger's hold, handed to the port.
 *
 * **The row is locked while it is read and written** — the same guarantee
 * `postMovements` gives. Without it two customers confirm the last piece:
 * both read `available = 1`, both write, and one is promised goods that are
 * not there ([backlog #13](../../../../docs/reference/backlog.md)).
 *
 * A reservation never touches `on_hand` or the weighted average: the goods
 * are still ours and still on the shelf. Only `reserved` moves, and the till
 * reads `on_hand − reserved`.
 */
export function installInventoryReservation(): void {
  registerReservation(
    async ({ exec, branchId, lines }: ReservationRequest) => {
      const shortfalls: ReservationShortfall[] = [];
      for (const line of lines) {
        const current = await stockRepository.lockBalance(exec, branchId, line.variantId);
        const onHand = current ? Number(current.on_hand) : 0;
        const reserved = current ? Number(current.reserved) : 0;
        const available = onHand - reserved;
        if (available < line.qtyBase) {
          // **ما لا يمكن حجزه يُقال برقمه**: «غير متاح» بلا عددٍ يجعل الزبون
          // يخفّض الكمية تخميناً، ويحاول ثلاث مرات.
          shortfalls.push({
            variantId: line.variantId,
            requested: line.qtyBase,
            available: Math.max(0, available),
          });
          continue;
        }
        await exec
          .update(stockBalancesTable)
          .set({ reserved: String(reserved + line.qtyBase), updated_at: new Date() })
          .where(
            sql`${stockBalancesTable.branch_id} = ${branchId} AND ${stockBalancesTable.variant_id} = ${line.variantId}`,
          );
      }
      return shortfalls;
    },
    async ({ exec, branchId, lines }: ReservationRequest) => {
      for (const line of lines) {
        const current = await stockRepository.lockBalance(exec, branchId, line.variantId);
        if (!current) continue;
        // **الأرضية صفر**: تحريرٌ مكرّر عطلٌ يُصلَح، لكن رقماً سالباً بالمحجوز
        // يجعل المتاح أكبر من الموجود — فيبيع الكاشير ما ليس عنده.
        const next = Math.max(0, Number(current.reserved) - line.qtyBase);
        await exec
          .update(stockBalancesTable)
          .set({ reserved: String(next), updated_at: new Date() })
          .where(
            sql`${stockBalancesTable.branch_id} = ${branchId} AND ${stockBalancesTable.variant_id} = ${line.variantId}`,
          );
      }
    },
  );
}
