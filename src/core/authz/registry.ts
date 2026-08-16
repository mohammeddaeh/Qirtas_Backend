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
 * It does not replace the `permissions` **table** — the table is what the roles
 * screen reads, and it still holds `module`, `is_sensitive` and the display
 * names. What changed is where those values come from: the route declares them
 * (below), and `seed-core.ts` writes them. The hand-written list stopped being
 * the source and became a fallback for keys declared before this existed.
 */

/** Bilingual name. Both languages, always — a label with one is a label half the users cannot read. */
export interface PermissionDisplay {
  ar: string;
  en: string;
}

/** What a route may say about the permission it enforces, beyond its name. */
export interface PermissionMeta {
  /**
   * The name an administrator reads in the roles screen.
   *
   * **Supplying it is what makes a new permission need no second edit.** Without
   * it the key must appear in `PERMISSIONS` in `seed-core.ts` for its display
   * name, which is exactly the hand-maintained list this module exists to
   * remove. The seed refuses a key that has neither, naming it — so the gap is
   * a boot-time message, not a permission that renders as a raw string.
   */
  display?: PermissionDisplay;

  /**
   * Marks a permission whose grant deserves a second look — the roles screen
   * flags it. Defaults to `false`.
   *
   * `users.manage`, `branches.manage` and `records.archive` are the existing
   * examples: each one lets its holder reshape something other people depend on.
   */
  sensitive?: boolean;
}

/** One registered key, with everything the catalogue needs to exist. */
export interface RegisteredPermission {
  key: string;
  module: string;
  action: string;
  display?: PermissionDisplay;
  sensitive: boolean;
}

const permissions = new Map<string, RegisteredPermission>();

/**
 * Called by `requirePermission()` at module load — and, in the normal course of
 * building a feature, by nothing else.
 *
 * ## The whole point, in one example
 *
 * ```ts
 * ordersRouter.post(
 *   '/',
 *   requirePermission('orders.create', { display: { ar: 'إنشاء طلب', en: 'Create Order' } }),
 *   …
 * );
 * ```
 *
 * That line **is** the permission. It guards the route, and `npm run db:seed`
 * creates the catalogue row, its ar/en names, and every grant the roles in
 * `seed-core.ts` already planned for it. No list to edit, nothing to remember,
 * and no way for the catalogue to describe a permission the server does not
 * check — because the catalogue is now written from the guards themselves.
 *
 * ## Duplicates
 *
 * Registering the same key twice is the normal case (`roles.edit` guards six
 * routes), so it is idempotent, and metadata may be declared on **any one** of
 * them. Two routes disagreeing about the same key's name throws at boot rather
 * than letting import order decide which one ships.
 */
export function registerPermission(key: string, meta: PermissionMeta = {}): string {
  if (!isValidKey(key)) {
    throw new Error(
      `Invalid permission key "${key}" — expected "module.action" in lower snake case (module plural), e.g. "orders.create". See docs/reference/users_roles.md.`,
    );
  }

  const existing = permissions.get(key);

  if (!existing) {
    const { module, action } = parseKey(key);
    permissions.set(key, {
      key,
      module,
      action,
      display: meta.display,
      sensitive: meta.sensitive ?? false,
    });
    return key;
  }

  if (meta.display) {
    if (existing.display && !sameDisplay(existing.display, meta.display)) {
      throw new Error(
        `Permission "${key}" is declared with two different display names ("${existing.display.en}" and "${meta.display.en}"). Declare it on one route; the others inherit it.`,
      );
    }
    existing.display = meta.display;
  }

  // `sensitive` only ever tightens: one route treating a key as sensitive is
  // enough, and the looser declaration must not be able to undo it depending on
  // which file happened to load first.
  if (meta.sensitive) existing.sensitive = true;

  return key;
}

function sameDisplay(a: PermissionDisplay, b: PermissionDisplay): boolean {
  return a.ar === b.ar && a.en === b.en;
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
