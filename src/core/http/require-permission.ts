import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from './api-error.js';
import { requireActorId } from './require-actor.js';
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
 */
export function requirePermission(permissionKey: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const actorUserId = requireActorId(req);
      const keys = await userRoleAssignmentsRepository.findAllEffectivePermissionKeys(actorUserId);
      if (!keys.includes(permissionKey)) {
        throw new ForbiddenError(`Missing required permission: ${permissionKey}`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
