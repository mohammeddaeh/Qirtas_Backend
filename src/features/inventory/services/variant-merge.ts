import { db } from '../../../core/db/client.js';
import { registerVariantMergeHandler } from '../../../core/records/variant-merge.js';
import * as stockRepository from '../repositories/stock.repository.js';
import { applyReceipt } from './stock-rules.js';

/**
 * The ledger's half of a merge: every movement, layer and balance that points
 * at the draft's variant is moved onto the real one.
 *
 * Balances are **not** simply re-pointed — a branch may hold both items
 * already. The two are combined the way a receipt is (`applyReceipt`): the
 * quantities add and the costs weigh against each other, because that is what
 * happened in the shop, whatever the paperwork called them.
 */
export function installVariantMergeHandler(): void {
  registerVariantMergeHandler(async (fromVariantId, toVariantId) => {
    await db.transaction(async (tx) => {
      const balances = await stockRepository.findBalancesOfVariant(fromVariantId);
      for (const source of balances) {
        const target = await stockRepository.lockBalance(tx, source.branch_id, toVariantId);
        const merged = applyReceipt(
          {
            onHand: target ? Number(target.on_hand) : 0,
            avg: {
              syp: target ? Number(target.avg_cost_syp) : 0,
              usd: target ? Number(target.avg_cost_usd) : 0,
            },
          },
          Number(source.on_hand),
          { syp: Number(source.avg_cost_syp), usd: Number(source.avg_cost_usd) },
        );
        await stockRepository.upsertBalance(tx, source.branch_id, toVariantId, {
          on_hand: merged.onHand,
          avg_cost_syp: merged.avg.syp,
          avg_cost_usd: merged.avg.usd,
        });
      }
      // The ledger keeps every row it ever wrote; the rows simply name the
      // item they always meant. Deleting and re-posting them would rewrite
      // history, which is the one thing an append-only ledger must not do.
      await stockRepository.repointVariant(tx, fromVariantId, toVariantId);
    });
  });
}
