/**
 * "May this record still be deleted?" asked across module lines.
 *
 * The catalog decides a product is deletable from catalog facts alone, but a
 * product a branch has received stock against is referenced by the ledger —
 * and the ledger belongs to `features/inventory`. Without this port the
 * delete reached PostgreSQL, hit a `RESTRICT` foreign key and came back as a
 * **500**: a real refusal, worded as a crash, with nothing for the reader to
 * do about it.
 *
 * A port rather than an import, for the same reason as `core/audit`: the
 * catalog must not import the inventory feature (`Features → Features ❌`).
 * The composition root registers the checker; a server that ships without the
 * inventory module simply has none, and nothing blocks.
 */

export type GuardedEntity = 'product' | 'variant';

/** How many rows in the guard's own tables point at these records. */
export type DeletionGuard = (entity: GuardedEntity, ids: number[]) => Promise<number>;

const guards: DeletionGuard[] = [];

export function registerDeletionGuard(guard: DeletionGuard): void {
  guards.push(guard);
}

/** Test seam — the registry is module state, and a test that adds a guard must be able to remove it. */
export function clearDeletionGuards(): void {
  guards.length = 0;
}

/**
 * The number of references outside the asking module. `0` means every
 * registered guard said "nothing of mine points at it"; with no guards
 * registered it is also `0`, which is the honest answer for a server that
 * does not run those modules.
 */
export async function countExternalReferences(entity: GuardedEntity, ids: number[]): Promise<number> {
  if (ids.length === 0 || guards.length === 0) return 0;
  const counts = await Promise.all(guards.map((guard) => guard(entity, ids)));
  return counts.reduce((sum, value) => sum + value, 0);
}
