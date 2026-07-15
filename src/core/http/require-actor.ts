import type { Request } from 'express';
import { UnauthorizedError } from './api-error.js';

/**
 * Reads the authenticated actor from req.user (populated by
 * core/middleware/auth.stub.ts — currently always null since real auth
 * isn't built yet, see CLAUDE.md). Throws UnauthorizedError when absent,
 * so every actor-requiring endpoint already behaves correctly the moment
 * auth.stub.ts starts resolving a real identity — no feature-level changes
 * needed then.
 */
export function requireActorId(req: Request): number {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }
  return req.user.id;
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
