/**
 * "This item turned out to be that item — move everything across."
 *
 * A branch draft merged into a real product must carry its stock with it
 * (inventory_suppliers.md §٢): movements, balances and receipt layers all
 * point at the draft's variant, and deleting it without moving them would
 * either fail on a foreign key or, worse, strand a branch's stock on a record
 * nobody can find.
 *
 * The catalog owns products and the inventory owns the ledger, and neither
 * may import the other (`Features → Features ❌`). So the catalog announces
 * the merge through this port and the inventory does its own half — the same
 * shape as `core/audit` and `core/records/deletion-guards`.
 */

export type VariantMergeHandler = (fromVariantId: number, toVariantId: number) => Promise<void>;

const handlers: VariantMergeHandler[] = [];

export function registerVariantMergeHandler(handler: VariantMergeHandler): void {
  handlers.push(handler);
}

/** Test seam: the registry is module state. */
export function clearVariantMergeHandlers(): void {
  handlers.length = 0;
}

/**
 * Runs every registered half, in order, before the catalog removes the source
 * variant. A handler that throws aborts the merge — which is the right
 * outcome: half-moved stock is worse than an unmerged draft.
 */
export async function moveVariantRecords(fromVariantId: number, toVariantId: number): Promise<void> {
  for (const handler of handlers) await handler(fromVariantId, toVariantId);
}
