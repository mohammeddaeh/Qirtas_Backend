/**
 * Prints every permission this server enforces, as JSON — `npm run print:permissions`.
 *
 * ## Why it exists
 *
 * The Flutter app gates controls on string keys. Typing them by hand makes the
 * two halves agree by **convention**, and a convention that is only checked at
 * runtime is checked when a user opens that screen — which, for a rarely-used
 * button, can be after release.
 *
 * This is the machine-readable half of the fix: the client generates constants
 * from it (`dart run scripts/sync_permission_keys.dart --from <file>`), so a
 * mistyped key stops compiling and a key **deleted here breaks the build there**
 * instead of silently hiding a control forever.
 *
 * ## Why a file and not the live endpoint
 *
 * `GET /users/me?include_declared=true` answers the same question, and the
 * generator still accepts it. But it needs a running server, a database, a
 * valid token and an account — four things that can each be wrong, on a task
 * that is pure code generation. Reading the registry directly needs none of
 * them: the keys are a property of the source, not of a deployment.
 *
 * Deliberately writes nothing but JSON to stdout, so it can be piped.
 */
import '../../app.js';
import { listEnforcedPermissions, listUmbrellaKeys } from './registry.js';

/**
 * ## Why `sensitive` is not published here
 *
 * The registry carries a `sensitive` flag, but **no route sets it** — it exists
 * only so that a route may tighten a key, and none has needed to. Meanwhile the
 * real values live in `seed-core.ts` and reach the `permissions.is_sensitive`
 * column, where five of the sixteen enforced keys are `true`.
 *
 * So publishing the registry's copy shipped `sensitive: false` for
 * `roles.edit`, `permissions.manage`, `branches.manage`, `ownerships.manage`
 * and `records.archive` — **the opposite of what the database says**. A reader
 * branching on it would get exactly the sensitive keys wrong, which is worse
 * than not having the field at all.
 *
 * The catalogue is the authority on sensitivity; this file is the authority on
 * *which keys are enforced*. It publishes only that.
 */
const payload = {
  generated_from: 'qirtas_backend/src/core/authz/registry.ts',
  enforced: listEnforcedPermissions().map((p) => ({
    key: p.key,
    resource: p.module,
  })),
  // Grant-only keys. Included because the app may legitimately gate on one —
  // "show this section to anyone who owns users" — and excluding them would
  // make a valid key look like a typo to the generator.
  umbrellas: listUmbrellaKeys(),
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
