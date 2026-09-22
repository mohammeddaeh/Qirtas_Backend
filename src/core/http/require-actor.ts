import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from './api-error.js';
import { markAccess } from './route-marker.js';

/**
 * Reads the authenticated actor from req.user (populated by
 * core/middleware/auth.ts from the Bearer token's session). Throws
 * UnauthorizedError when absent (no/invalid/expired token) — every
 * actor-requiring endpoint enforces auth here, not in auth.ts itself.
 */
export function requireActorId(req: Request): number {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required', 'authentication_required');
  }
  return req.user.id;
}

/**
 * Route-level guard for endpoints that only need "someone is logged in"
 * (no specific permission check) — e.g. list/read endpoints. Mount before
 * validate()/asyncHandler() on any route that isn't explicitly public.
 * Public routes (register/login/bootstrap-super-admin) never use this.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  requireActorId(req);
  next();
}

// Classifies every route it guards as "any signed-in account", so
// `npm run check:permissions` can tell a route deliberately left open to all
// members from one whose guard was forgotten. See `route-marker.ts`.
markAccess(requireAuth, { kind: 'authenticated' });

/** Shape shared by every service call that needs to write an AuditLogEntry. */
export interface RequestActorContext {
  userId: number;
  ipAddress: string | null;
  deviceInfo: string | null;
  performedByRole: string | null;
  branchContext: number | null;
}

/** Builds the actor context from the current request — role/branch context is filled in once real auth resolves req.user's assignments. */
export function buildActorContext(req: Request, actorUserId: number): RequestActorContext {
  return {
    userId: actorUserId,
    ipAddress: req.ip ?? null,
    deviceInfo: req.header('User-Agent') ?? null,
    performedByRole: null,
    branchContext: null,
  };
}

/**
 * A signed-in staff account that has been **approved** — `requireAuth` plus
 * `status === 'active'`.
 *
 * ## Why `requireAuth` was not enough
 *
 * A staff session is admitted before approval on purpose: `pending_verification`,
 * `pending_approval` and `rejected` accounts sign in so they can enter their
 * code, watch their request and resubmit (`canSignIn`). The stated rule was
 * that such a session "unlocks nothing" — true of every `requirePermission`
 * route, because an unapproved account holds no assignment. But `requireAuth`
 * means *any* staff session, so the routes guarded by it alone (the branch
 * list, the permission catalogue, data export) answered an applicant the
 * organisation had not accepted — or had just rejected.
 *
 * `requireAuth` is left as it is: the account's own routes (`/users/me`,
 * resubmission) are exactly what an applicant needs.
 */
export function requireApprovedStaff(req: Request, _res: Response, next: NextFunction): void {
  requireActorId(req);
  if (req.user?.status !== 'active') {
    throw new ForbiddenError(
      'This account has not been approved yet',
      { account_status: req.user?.status },
      'account_not_approved',
    );
  }
  next();
}

// Still "any signed-in member" to the permission checker — no key is involved.
markAccess(requireApprovedStaff, { kind: 'authenticated' });
