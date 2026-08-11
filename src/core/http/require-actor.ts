import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from './api-error.js';

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
