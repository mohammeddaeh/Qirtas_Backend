import { isEnforced, isUmbrellaKey, listEnforcedPermissions } from './registry.js';
import { parseKey } from './key-grammar.js';

/**
 * **Every authorization rule in Qirtas, in one file.**
 *
 * That is a constraint, not a coincidence of size. Rules spread across a
 * codebase become impossible to state: nobody can answer "why can this account
 * do that?" without reading everything. Here the complete answer is two rules,
 * and any future rule has exactly one place it can go.
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | every action implies its resource's `view` | otherwise "edit granted, list empty" — a bug that reads as a broken app, not a missing permission |
 * | 2 | a deny removes the key **and everything that implies it** | the contrapositive of rule 1 |
 *
 * ## Rule 2 is the one worth pausing on
 *
 * "Deny wins" is the easy half. The hard half is what a deny on a *read* means
 * when a *write* on the same resource is granted. Taking the deny literally
 * produces exactly the broken state rule 1 exists to prevent, arrived at from
 * the other direction. Closing the deny upward instead keeps one invariant true
 * no matter which way the matrix was filled in:
 *
 *     an account that can act on a resource can always see it.
 *
 * The cost is that denying `roles.view` also revokes `roles.edit` — which is
 * what an administrator ticking "block viewing roles" means.
 *
 * ## What it deliberately does not do
 *
 * No wildcards, no `manage` shorthand. Qirtas grants keys one at a time through
 * a screen built for exactly that, and a wildcard would make a role's stored
 * set differ from what the screen shows. The template carries those because it
 * has no roles screen of its own to keep honest.
 */

const VIEW_ACTION = 'view';

/** True for `roles.view` and for `orders.delivery.view` alike — the verb is the last segment. */
function isViewKey(key: string): boolean {
  const { action } = parseKey(key);
  const lastDot = action.lastIndexOf('.');
  return (lastDot === -1 ? action : action.slice(lastDot + 1)) === VIEW_ACTION;
}

/**
 * The read this key requires — **the nearest declared one**.
 *
 * For `orders.delivery.update` that is `orders.delivery.view` when the module
 * declares it, and `orders.view` otherwise. Nesting exists because a sub-area
 * has its own screen, so implying the module-wide read would grant more than
 * the tick asked for; falling back keeps the rule useful on flat modules, which
 * is most of them.
 *
 * `null` for a key that *is* a read, and for a module with no read endpoint at
 * all — nothing to imply in either case.
 */
export function impliedViewKey(key: string): string | null {
  if (!isEnforced(key)) return null;
  if (isViewKey(key)) return null;

  const { module, action } = parseKey(key);

  if (action.includes('.')) {
    const sibling = `${key.slice(0, key.lastIndexOf('.'))}.${VIEW_ACTION}`;
    if (isEnforced(sibling)) return sibling;
  }

  const moduleView = `${module}.${VIEW_ACTION}`;
  return isEnforced(moduleView) ? moduleView : null;
}

/** An override row, as the resolver reads it. */
export interface OverrideInput {
  permission_key: string;
  effect: 'allow' | 'deny';
}

/**
 * The whole resolution: what the roles granted, plus allows, minus denies.
 *
 * Deliberately free of I/O so the rules can be tested against two arrays — the
 * alternative is a test that needs a database to answer "does deny beat allow",
 * which is a question about this function alone.
 *
 * Unknown keys are **ignored, not rejected**: a grant or an override outlives
 * the endpoint it was written for, and a stale row must not fail a request for
 * an account whose other grants are perfectly valid.
 */
export function resolvePermissions(
  roleGrants: Iterable<string>,
  overrides: Iterable<OverrideInput>,
): Set<string> {
  const allowed = new Set<string>();

  const add = (key: string): void => {
    // Rule 0 — the umbrella. `users.manage` is every `users.*` key, including
    // ones added after the grant was stored. It is what let the coarse
    // `users.manage` be split into seven keys without migrating a single
    // existing role.
    if (isUmbrellaKey(key)) {
      const module = key.slice(0, key.indexOf('.'));
      for (const p of listEnforcedPermissions()) {
        if (p.module === module) allowed.add(p.key);
      }
      return;
    }

    if (!isEnforced(key)) return;
    allowed.add(key);
    // Rule 1 — the floor.
    const view = impliedViewKey(key);
    if (view) allowed.add(view);
  };

  for (const key of roleGrants) add(key);
  // Allows go through the same expansion as role grants: an exception granting
  // `orders.update` must carry its read exactly as a role would, or the two
  // paths to the same permission would behave differently.
  for (const o of overrides) if (o.effect === 'allow') add(o.permission_key);

  // Applied as a second pass, never interleaved: a deny has to be able to
  // remove something a role granted, and an interleaved evaluation would make
  // the outcome depend on row order.
  for (const o of overrides) {
    if (o.effect !== 'deny') continue;
    const denied = o.permission_key;

    // A denied umbrella removes the whole module — the mirror of rule 0.
    if (isUmbrellaKey(denied)) {
      const module = denied.slice(0, denied.indexOf('.'));
      for (const p of listEnforcedPermissions()) {
        if (p.module === module) allowed.delete(p.key);
      }
      continue;
    }

    if (!isEnforced(denied)) continue;

    allowed.delete(denied);

    // Rule 2 — the contrapositive of rule 1. Denying a read denies every action
    // that would have implied *that* read.
    if (isViewKey(denied)) {
      for (const p of listEnforcedPermissions()) {
        if (impliedViewKey(p.key) === denied) allowed.delete(p.key);
      }
    }
  }

  return allowed;
}
