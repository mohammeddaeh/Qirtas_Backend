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
