import { logger } from '../../../core/logger/logger.js';
import { env } from '../../../core/config/env.js';
import { notifyShopper, SHOPPING_NOTIFICATION } from '../../../core/notifications/index.js';
import { resolvePricesAt } from '../../../core/pricing/price-port.js';
import * as demandRepository from '../repositories/demand.repository.js';

/**
 * «أعلمني عند التوفّر» — the half that tells (store_system.md §٨, 2026-10-07).
 *
 * The request rows were saved from 5-د on, and nothing ever answered them: the
 * button said «سنعلمك» and the shop never did. Nothing failed — the row sat
 * there with `notified_at` empty and the customer bought elsewhere.
 *
 * **A sweep, not a hook on every stock movement.** Goods reach a shelf through
 * receipts, transfers, counts, returns, merges and released reservations — and
 * a price set or a branch re-listing makes goods already there buyable. A hook
 * at each of those is a list that is complete today and missing one tomorrow,
 * silently. Asking «what is waiting and now buyable?» every few minutes covers
 * every path, including ones not written yet.
 *
 * Both kinds are answered the same way: `request_here` asked for it at this
 * branch, and it is here now.
 */

export const BACK_IN_STOCK_INTERVAL_MS = 5 * 60 * 1000;
const BATCH = 500;

export interface BackInStockResult {
  notified: number;
}

export async function sweepBackInStock(now: Date = new Date()): Promise<BackInStockResult> {
  const candidates = await demandRepository.findOpenDemandInStock(BATCH);
  if (candidates.length === 0) return { notified: 0 };

  // Stock is not enough: an unpriced or withdrawn item is not for sale, and
  // telling someone to come for it repeats the dead end they asked about.
  const byBranch = new Map<number, number[]>();
  for (const row of candidates) byBranch.set(row.branch_id, [...(byBranch.get(row.branch_id) ?? []), row.variant_id]);
  const buyable = new Set<string>();
  for (const [branchId, variantIds] of byBranch) {
    const prices = await resolvePricesAt(branchId, [...new Set(variantIds)], {
      promotions: 'ignore',
      channel: 'online',
      segment: 'retail',
    });
    for (const [variantId, price] of prices) {
      if (price.status === 'priced') buyable.add(`${branchId}:${variantId}`);
    }
  }

  const ready = candidates.filter((row) => buyable.has(`${row.branch_id}:${row.variant_id}`));
  const claimed = new Set(await demandRepository.claimNotified(ready.map((r) => r.id), now));
  for (const row of ready) {
    if (!claimed.has(row.id)) continue;
    notifyShopper({
      customerId: row.customer_id,
      event: SHOPPING_NOTIFICATION.backInStock,
      text: { productAr: row.product_name_ar, productEn: row.product_name_en, branch: row.branch_name },
      data: { product_id: String(row.product_id), variant_id: String(row.variant_id), branch_id: String(row.branch_id) },
    });
  }
  return { notified: claimed.size };
}

/** `unref()` so the timer never keeps the process alive during a graceful shutdown. */
export function startBackInStockSweep(): void {
  if (env.NODE_ENV === 'test') return;
  setInterval(() => {
    void sweepBackInStock().then(
      (result) => {
        if (result.notified > 0) logger.info(result, 'Back-in-stock sweep');
      },
      (err: unknown) => logger.warn({ err }, 'Back-in-stock sweep failed — will retry on the next interval'),
    );
  }, BACK_IN_STOCK_INTERVAL_MS).unref();
}
