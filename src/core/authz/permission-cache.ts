/**
 * **A user's resolved permission set, remembered for a few seconds**
 * (2026-10-14).
 *
 * Every guarded request resolved the set from scratch — a four-table join and
 * an overrides query — and many handlers then asked again for a branch
 * (`requireScope`, cost visibility, pickup) two to six more times in the same
 * request. A board polling every 30s from several devices multiplied that.
 *
 * - **Five seconds**: long enough to cover one request and the burst of calls a
 *   screen makes as it opens, short enough that a revoked grant stops working
 *   almost at once even on another server process.
 * - **Cleared on every grant write** in this process ([clearPermissionCache] —
 *   assignments, role permissions, role state, overrides), so the admin who
 *   changes a role sees the change on the next request.
 * - The **promise** is stored, so concurrent calls share one query.
 */
const TTL_MS = 5_000;

const entries = new Map<string, { at: number; value: Promise<string[]> }>();

export function cachedPermissionKeys(key: string, load: () => Promise<string[]>): Promise<string[]> {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = load();
  entries.set(key, { at: now, value });
  // A failed load is not remembered — the next call asks again.
  value.catch(() => entries.delete(key));
  if (entries.size > 5_000) entries.clear();
  return value;
}

/** Any grant changed — forget every remembered set in this process. */
export function clearPermissionCache(): void {
  entries.clear();
}
