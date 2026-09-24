import { countMovementsFor } from '../repositories/stock.repository.js';
import { registerDeletionGuard, type GuardedEntity } from '../../../core/records/deletion-guards.js';

/**
 * The ledger's answer to "may this be deleted": how many movements point at
 * it. Registered by the composition root, so a server without this feature
 * simply has no opinion rather than a hidden one.
 */
export function installInventoryDeletionGuard(): void {
  registerDeletionGuard(async (entity: GuardedEntity, ids: number[]) => countMovementsFor(entity, ids));
}
