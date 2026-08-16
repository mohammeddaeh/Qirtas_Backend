/**
 * Static check: **the guards, the catalog and the routes must agree** —
 * `npm run check:permissions`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Qirtas keeps its permission catalog in two places that nothing compared:
 * the `PERMISSIONS` list in `core/db/seed-core.ts` (what an administrator can
 * grant) and the `requirePermission('…')` calls across ten routers (what the
 * server actually refuses). An audit on 2026-08-13 compared them for the first
 * time and found **17 seeded keys that no route enforces** — permissions that
 * appear in the roles screen, get ticked, and gate nothing.
 *
 * That half is misleading. The other direction is dangerous: a key a route
 * enforces but nothing seeds can never be held by anyone, so the endpoint is
 * shut for every user **including the Super Admin**, and nothing reports it.
 * A gate that is always shut reads in code exactly like a gate that works.
 *
 * And a third failure needs no catalog at all: a route that simply forgot its
 * guard. It looks exactly like a route meant to be public, and past forty
 * guarded routes nobody can tell them apart by reading.
 *
 * ── The three checks ───────────────────────────────────────────────────────
 *  1. **Coverage** — every mounted route declares `publicRoute`, `requireAuth`
 *     or `requirePermission()`. Unclassified = failure.
 *  2. **No shut gates** — every enforced key exists in the seeded catalog.
 *     Missing = failure.
 *  3. **No orphan keys** — every seeded key is enforced somewhere. Unenforced
 *     = warning, listed by name.
 *
 * (1) and (2) fail the run; (3) reports. Orphans are legitimate while a module
 * is still being built (`orders.*`, `printing.*`), so failing on them would
 * make the check something people switch off — which is how a check stops
 * being read at all.
 *
 * Same argument as `core/i18n/check-message-keys.ts`, and the same shape:
 * a written rule with no check is a suggestion.
 *
 * ── Note on how it runs ────────────────────────────────────────────────────
 * It **imports** the app rather than parsing source text: importing the routers
 * is what makes every `requirePermission()` call register its key, so the list
 * is the real one rather than a regex's guess at it. Needs `.env` present (like
 * `db:seed` and `smoke`); it opens no database connection.
 */
import { API_ROUTERS } from '../../app.js';
import { readAccess, type RouteAccess } from '../http/route-marker.js';
import { listEnforcedPermissions } from './registry.js';
import { SEEDED_PERMISSION_KEYS } from '../db/seed-core.js';

interface ExpressLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
}

interface RouteDescriptor {
  label: string;
  access: RouteAccess | undefined;
}

function collectRoutes(): RouteDescriptor[] {
  const out: RouteDescriptor[] = [];

  for (const { path, router } of API_ROUTERS) {
    const stack = (router as unknown as { stack: ExpressLayer[] }).stack;

    for (const layer of stack) {
      if (!layer.route) continue;

      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route!.methods[m])
        .map((m) => m.toUpperCase())
        .join('|');

      // The first tag wins. A route mounts at most one classifier, and reading
      // the first keeps the answer stable if a future middleware ever carries
      // one incidentally.
      const access = layer.route.stack.map((entry) => readAccess(entry.handle)).find(Boolean);

      out.push({
        label: `${methods} ${path}${layer.route.path === '/' ? '' : layer.route.path}`,
        access,
      });
    }
  }

  return out;
}

function main(): void {
  const routes = collectRoutes();
  const enforced = listEnforcedPermissions().map((p) => p.key);
  const seeded = [...SEEDED_PERMISSION_KEYS].sort();

  let failed = false;

  // The guard on the guard. If Express ever changes the shape this walks,
  // `collectRoutes()` returns [] and every check below passes vacuously —
  // the one way this file could fail to do its job while staying green.
  if (routes.length < 20) {
    console.error(
      `❌ Only ${routes.length} routes found — the router walker is broken, not the routes.`,
    );
    process.exit(1);
  }

  // ── 1. Coverage ──────────────────────────────────────────────────────────
  const unclassified = routes.filter((r) => !r.access);
  if (unclassified.length > 0) {
    failed = true;
    console.error(`\n❌ ${unclassified.length} route(s) declare no access rule:\n`);
    for (const route of unclassified) console.error(`   ${route.label}`);
    console.error(
      '\n   Neither `requireAuth`, `requirePermission()` nor `publicRoute` — so nothing',
      '\n   distinguishes "meant to be open" from "guard forgotten".',
      '\n   Add one. `publicRoute` is a no-op whose only job is to state the intent.',
    );
  }

  // ── 2. No shut gates ─────────────────────────────────────────────────────
  const unseeded = enforced.filter((key) => !seeded.includes(key));
  if (unseeded.length > 0) {
    failed = true;
    console.error(`\n❌ ${unseeded.length} enforced key(s) are not in the seeded catalog:\n`);
    for (const key of unseeded) console.error(`   ${key}`);
    console.error(
      '\n   Nobody can hold these, so their endpoints are shut for EVERY user —',
      '\n   including the Super Admin — and nothing logs it.',
      '\n   Add them to PERMISSIONS in src/core/db/seed-core.ts.',
    );
  }

  // ── 3. Planned keys (informational) ──────────────────────────────────────
  const orphans = seeded.filter((key) => !enforced.includes(key));
  if (orphans.length > 0) {
    console.log(`\nℹ️  ${orphans.length} planned key(s) — declared by no route, so NOT seeded:\n`);
    for (const key of orphans) console.log(`   ${key}`);
    console.log(
      '\n   These live in PERMISSIONS as a plan for modules not yet built. They are',
      '\n   held out of the database, so no administrator sees a permission that',
      '\n   gates nothing. Write `requirePermission(<key>)` on its route and the',
      '\n   next `npm run db:seed` creates it AND grants it to every role that',
      '\n   already planned for it — no second edit, nothing to remember.',
    );
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    `\n✅ ${routes.length} routes classified · ${enforced.length} keys enforced and seeded` +
      (orphans.length > 0 ? ` · ${orphans.length} planned, held back` : ''),
  );
}

main();
