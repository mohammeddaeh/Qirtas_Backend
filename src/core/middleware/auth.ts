import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessionsTable } from '../../features/identity/schemas/sessions.schema.js';
import { usersTable } from '../../features/identity/schemas/users.schema.js';
import { env } from '../config/env.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: { id: number } | null;
    }
  }
}

const IDLE_TIMEOUT_MS = env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;

/**
 * Resolves req.user from the Bearer token against the sessions table
 * (features/identity/schemas/sessions.schema.ts — direct table import here
 * mirrors the existing core/db/seed.ts precedent for composition-root-style
 * infra code, not a feature repository/service call).
 *
 * A session idle for longer than SESSION_IDLE_TIMEOUT_MINUTES (measured from
 * last_active_at) is treated as expired and deleted outright — the caller
 * gets the same req.user = null as an unknown/absent token.
 *
 * Also verifies the session's owning user is still status='active'
 * (docs/reference/session_permission_integrity.md §5, decided 2026-07-27) —
 * a disabled/suspended/rejected/pending_approval user's still-valid session
 * is treated exactly like an invalid/absent token, and the session row is
 * deleted at the same time (proactive cleanup, avoids re-checking the same
 * dead session on every subsequent request).
 *
 * Never rejects the request itself — an absent/invalid/expired token, or a
 * token belonging to a non-active user, simply leaves req.user = null.
 * Enforcement stays entirely at requireAuth()/requireActorId() (see
 * require-actor.ts), so route/feature code doesn't change shape.
 */
export async function auth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (!token) {
    req.user = null;
    next();
    return;
  }

  const rows = await db
    .select({ session: sessionsTable, userStatus: usersTable.status })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(usersTable.id, sessionsTable.user_id))
    .where(eq(sessionsTable.token, token))
    .limit(1);
  const row = rows[0];

  if (!row) {
    req.user = null;
    next();
    return;
  }

  const { session, userStatus } = row;

  const idleMs = Date.now() - session.last_active_at.getTime();
  if (idleMs > IDLE_TIMEOUT_MS) {
    await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));
    req.user = null;
    next();
    return;
  }

  if (userStatus !== 'active') {
    await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));
    req.user = null;
    next();
    return;
  }

  db.update(sessionsTable)
    .set({ last_active_at: new Date() })
    .where(eq(sessionsTable.id, session.id))
    .catch(() => {
      /* best-effort activity tracking — never blocks the request */
    });

  req.user = { id: session.user_id };
  next();
}
