import { parseKey, isValidKey } from './key-grammar.js';

/**
 * **What this server actually enforces** — collected from the routes, never
 * written by hand.
 *
 * ## The gap it closes
 *
 * Qirtas already has a permission catalog: the `permissions` table, seeded from
 * `PERMISSIONS` in `core/db/seed-core.ts`. That list is maintained by a person,
 * and the set of keys `requirePermission()` actually checks is maintained by
 * different people in different files. Nothing compared them.
 *
 * An audit on 2026-08-13 compared them for the first time:
 *
 * ```
 * keys a route enforces:        10
 * keys seeded in the catalog:   27
 * seeded but enforced by nothing: 17
 * ```
 *
 * Seventeen permissions appear in the roles screen, an administrator ticks
 * them, and they gate nothing. That half is merely misleading. **The other
 * direction is the dangerous one**: a `requirePermission('orders.refund')`
 * whose row was never seeded can never be held by anyone, so the endpoint is
 * shut for every user including the Super Admin — and nothing anywhere reports
 * it. A gate that is always shut reads in code exactly like a gate that works.
 *
 * That direction had not happened yet. This registry plus
 * `npm run check:permissions` is what keeps it from happening: the check reads
 * this map — the keys the running process protects — and compares it against
 * the seeded catalog, in both directions.
 *
 * ## What it deliberately does NOT do
 *
 * It does not replace the `permissions` table. That table carries `module`,
 * `is_sensitive` and the bilingual display names the roles screen renders, and
 * it is the right home for them. The registry answers one narrower question the
 * table cannot: *which keys does the code enforce right now?*
 */

/** One registered key, with where it was declared. */
export interface RegisteredPermission {
  key: string;
  module: string;
  action: string;
}

const permissions = new Map<string, RegisteredPermission>();

/**
 * Called by `requirePermission()` at module load — and, in the normal course of
 * building a feature, by nothing else.
 *
 * Registering the same key twice is the normal case (`roles.edit` guards six
 * routes), so it is idempotent. A malformed key throws **at boot**, before a
 * request can observe it: the `module.action` shape is what `check-permissions`
 * and the roles screen's grouping both read.
 */
export function registerPermission(key: string): string {
  if (!isValidKey(key)) {
    throw new Error(
      `Invalid permission key "${key}" — expected "module.action" in lower snake case (module plural), e.g. "orders.create". See docs/reference/users_roles.md.`,
    );
  }

  if (!permissions.has(key)) {
    const { module, action } = parseKey(key);
    permissions.set(key, { key, module, action });
  }

  return key;
}

/** Every key this process enforces, sorted. */
export function listEnforcedPermissions(): RegisteredPermission[] {
  return [...permissions.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function isEnforced(key: string): boolean {
  return permissions.has(key);
}

/** Test/tooling only. Registration is boot-time and one-way in a running process. */
export function clearPermissions(): void {
  permissions.clear();
}
