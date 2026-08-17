/**
 * Static check: **the guards, the catalog and the routes must agree** —
 * `npm run check:permissions`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Qirtas kept its permission catalogue in two places that nothing compared: the
 * `PERMISSIONS` list in `core/db/seed-core.ts` (what an administrator could
 * grant) and the `requirePermission('…')` calls across ten routers (what the
 * server actually refuses). An audit on 2026-08-13 compared them for the first
 * time and found **17 seeded keys that no route enforced** — permissions that
 * appeared in the roles screen, got ticked, and gated nothing.
 *
 * That was the visible half. The dangerous direction is the other one: a key a
 * route enforces but nothing seeds can never be held by anyone, so the endpoint
 * is shut for every user **including the Super Admin**, and nothing reports it.
 * A gate that is always shut reads in code exactly like a gate that works.
 *
 * Both are now structurally impossible: `seed-core.ts` derives the catalogue
 * from the registry, so the two cannot disagree. What this file still guards is
 * the third failure, which needs no catalogue at all — a route that simply
 * forgot its guard. It looks exactly like a route meant to be public, and past
 * seventy guarded routes nobody can tell them apart by reading.
 *
 * ── The three checks ───────────────────────────────────────────────────────
 *  1. **Coverage** — every mounted route declares `publicRoute`, `requireAuth`
 *     or `requirePermission()`. Unclassified = failure.
 *  2. **Every enforced key can be named** — from its route or from the plan.
 *     Unnamed = failure (and `db:seed` would refuse anyway, later and louder).
 *  3. **Planned keys** — in `PERMISSIONS` but declared by no route. Reported by
 *     name; they are deliberately **not** seeded.
 *
 * (1) and (2) fail the run; (3) informs. Planned keys are legitimate while a
 * module is still being built (`orders.*`, `printing.*`), so failing on them
 * would make the check something people switch off — which is how a check stops
 * being read at all.
 *
 * ⚠️ Check (2) used to be "every enforced key exists in the seeded catalogue".
 * That was right while the catalogue was a hand-written list. It stopped being
 * a check the day the seed started deriving from this same registry — the two
 * could no longer disagree — so it was replaced rather than left in place
 * looking useful.
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
import { isGrantable, listEnforcedPermissions } from './registry.js';
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

  // ── 2. Every enforced key can be named ───────────────────────────────────
  //
  // This used to compare against the hand-written catalogue, which was the
  // right check while that list was the source. It is not any more: the seed is
  // derived from this same registry, so that comparison could only ever pass.
  //
  // What can still go wrong is a key nobody named. `seed-core.ts` refuses it —
  // and refusing at seed time means discovering it while deploying. Here it is
  // caught while writing the route.
  const unnamed = listEnforcedPermissions()
    .filter((p) => !p.display && !seeded.includes(p.key))
    .map((p) => p.key);

  if (unnamed.length > 0) {
    failed = true;
    console.error(`\n❌ ${unnamed.length} enforced key(s) have no display name:\n`);
    for (const key of unnamed) console.error(`   ${key}`);
    console.error(
      '\n   The roles screen would render the raw key as its label, and',
      '\n   `npm run db:seed` refuses to run at all. Name it where it is declared:',
      '\n',
      `\n     requirePermission('${unnamed[0]}', {`,
      "\n       display: { ar: '…', en: '…' },",
      '\n     })',
    );
  }

  // ── 3. Planned keys (informational) ──────────────────────────────────────
  const orphans = seeded.filter((key) => !isGrantable(key));
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
