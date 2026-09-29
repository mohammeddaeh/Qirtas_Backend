import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from './api-error.js';
import { requireActorId } from './require-actor.js';
import { markAccess } from './route-marker.js';
import { registerPermission, type PermissionMeta } from '../authz/registry.js';
import * as userRoleAssignmentsRepository from '../../features/identity/repositories/user-role-assignments.repository.js';

/**
 * Route-level RBAC guard — requires the caller to hold `permissionKey` on at
 * least one of their currently active role assignments (branch-agnostic
 * union, see findAllEffectivePermissionKeys). Allow-only semantics
 * (users_roles.md): union across every active assignment, no deny rules.
 *
 * Mirrors the existing core/middleware/auth.ts precedent for importing a
 * feature repository directly from core/ infra code (composition-root-style
 * exception, not a feature-to-feature import).
 *
 * ## It now does two more things, and neither changes what it enforces
 *
 * 1. **Declares the key** (`core/authz/registry.ts`). The set of keys this
 *    server actually checks stops being something only a `grep` can answer,
 *    which is what lets `npm run check:permissions` compare it against the
 *    seeded catalog. That comparison found **17 seeded keys no route
 *    enforces**, and it is the only thing standing between this codebase and
 *    the reverse case: a key nothing seeded, whose endpoint is then shut for
 *    every user including the Super Admin, silently.
 * 2. **Classifies the route** (`core/http/route-marker.ts`), so a forgotten
 *    guard is distinguishable from a deliberately open endpoint.
 *
 * The middleware body below is byte-for-byte the behaviour it always had.
 */
/**
 * Passes when the caller holds **any** of the keys.
 *
 * For an endpoint that legitimately serves several audiences. The case it was
 * added for: the role **picker** feed. Choosing a role is part of approving a
 * registration, of creating a user, and of opening an assignment — three
 * different permissions — so demanding `roles.view` on top refused people who
 * were plainly entitled to do the job, with a 403 mid-task.
 *
 * Prefer a single key wherever one exists. Two keys on a route is a fact an
 * administrator has to reconstruct from the roles screen, and the screen cannot
 * show it.
 */
export function requireAnyPermission(permissionKeys: string[], meta: PermissionMeta = {}) {
  if (permissionKeys.length === 0) {
    throw new Error('requireAnyPermission() needs at least one key');
  }
  for (const key of permissionKeys) registerPermission(key, meta);

  const guard = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const actorUserId = requireActorId(req);
      const held = await userRoleAssignmentsRepository.findAllEffectivePermissionKeys(actorUserId);
      if (!permissionKeys.some((key) => held.includes(key))) {
        throw new ForbiddenError(
          `Missing one of: ${permissionKeys.join(', ')}`,
          undefined,
          'permission_missing',
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  return markAccess(guard, { kind: 'permission', keys: permissionKeys });
}

export function requirePermission(permissionKey: string, meta: PermissionMeta = {}) {
  registerPermission(permissionKey, meta);

  const guard = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const actorUserId = requireActorId(req);
      const keys = await userRoleAssignmentsRepository.findAllEffectivePermissionKeys(actorUserId);
      if (!keys.includes(permissionKey)) {
        throw new ForbiddenError(
          `Missing required permission: ${permissionKey}`,
          undefined,
          // The English fallback names the key for logs; the translated text does
          // not, because a raw permission key means nothing to the reader.
          'permission_missing',
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  return markAccess(guard, { kind: 'permission', keys: [permissionKey] });
}

/**
 * [requirePermission], applied only when [appliesTo] says this request needs it.
 *
 * For one route whose body decides which permission it needs — the case it was
 * added for is `POST /<module>/bulk`, where `archive`/`unarchive` need
 * `records.archive` on top of the module key (as their single-record routes
 * do) and `delete` does not. Checked for the whole request **before any row is
 * touched**, and refused with the identical `403 permission_missing`: a caller
 * without the key must not get a 200 full of per-row refusals for something
 * they could never do.
 *
 * Mount it **after** `validate(...)` so [appliesTo] reads a checked body. The
 * route still needs its unconditional guard first — this one is not a route
 * classifier (it carries no access mark), only a declared key.
 */
export function requirePermissionWhen(
  permissionKey: string,
  appliesTo: (req: Request) => boolean,
  meta: PermissionMeta = {},
) {
  // Declares the key too (requirePermission registers it).
  const guard = requirePermission(permissionKey, meta);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!appliesTo(req)) {
      next();
      return;
    }
    void guard(req, res, next);
  };
}

/**
 * Does the caller hold [permissionKey] **at [branchId]** — through an
 * assignment at that branch or an unrestricted one? `branchId = null` asks
 * for unrestricted only: "may this person act for every branch?".
 *
 * For checks a route guard cannot make, because the scope depends on the row
 * being written (a branch price on a `central_locked` product needs the
 * unrestricted grant; on a `branch_free` one, the branch's own is enough).
 * The route still carries `requirePermission(key)` so the key is declared and
 * a caller holding it nowhere is refused before any work.
 */
export async function holdsPermissionAt(
  actorUserId: number,
  permissionKey: string,
  branchId: number | null,
): Promise<boolean> {
  const keys = await userRoleAssignmentsRepository.findEffectivePermissionKeys(actorUserId, branchId);
  return keys.includes(permissionKey);
}
