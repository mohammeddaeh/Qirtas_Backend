import { authConfig } from '../config/auth-config.js';
import { generateSessionToken, hashToken } from './token.service.js';
import * as sessionsRepository from '../repositories/sessions.repository.js';
import type { SessionRow } from '../schemas/sessions.schema.js';

/**
 * Every rule about how long a session lives, when it rotates and when it dies.
 *
 * Policy lives here and nowhere else. Before this file the idle timeout was a
 * constant in `core/middleware/auth.ts`, revocation was a repository call made
 * from a business service, and nothing enforced an absolute lifetime at all —
 * so "how long is a session good for?" had three partial answers in three
 * files.
 *
 * ## The three independent ways a session ends
 *
 * 1. **Idle** — no request within `idleTimeoutMinutes` of `last_active_at`.
 *    Slides forward with use, so an active user never notices it.
 * 2. **Absolute** — `expires_at` passes, regardless of activity. This is what
 *    the idle timeout cannot express: a device polling in the background
 *    renews the idle window forever, making a token stolen from it effectively
 *    permanent.
 * 3. **Revoked** — someone ended it: logout, "sign out everywhere", a password
 *    reset, or an admin action.
 *
 * A fourth, `AccountStore.canSignIn` turning false, is enforced by the auth
 * middleware rather than here, because it is the application's rule and it must
 * be re-checked on every request, not only at session creation.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The token is returned exactly once, at creation or rotation. It is never readable afterwards — only its digest is stored. */
export interface IssuedSession {
  session: SessionRow;
  token: string;
}

export async function createSession(params: {
  userId: number;
  provider: string;
  deviceInfo?: string | null;
}): Promise<IssuedSession> {
  const token = generateSessionToken();
  const now = new Date();

  const session = await sessionsRepository.insert({
    user_id: params.userId,
    token_hash: hashToken(token),
    provider: params.provider,
    device_info: params.deviceInfo ?? null,
    created_at: now,
    last_active_at: now,
    last_rotated_at: now,
    // Written at creation rather than derived on read, so that changing the
    // policy later neither kills live sessions nor revives dead ones — the row
    // states its own deadline.
    expires_at: new Date(now.getTime() + authConfig.session.absoluteTimeoutDays * DAY_MS),
  });

  return { session, token };
}

/** Why a presented token was not accepted. Callers translate this into a response; the distinction never reaches the client verbatim. */
export type SessionRejection = 'unknown' | 'idle' | 'expired';

export type SessionLookup =
  | { ok: true; session: SessionRow }
  | { ok: false; reason: SessionRejection };

/**
 * Resolves a presented bearer token to a live session, deleting it if it has
 * ended.
 *
 * ## Why expired rows are deleted rather than left to a sweep
 *
 * The row has just been read, its identity is known, and it can never be valid
 * again — so the cheapest moment to remove it is now. Leaving it means every
 * subsequent request with the same dead token repeats the same lookup and the
 * same rejection. The periodic sweep (`purgeExpired`) still exists for sessions
 * whose owners simply never return.
 *
 * ## Why `last_active_at` is written fire-and-forget
 *
 * It is activity tracking, not authorization. Awaiting it would add a write to
 * the critical path of every authenticated request to make an idle timeout a
 * few milliseconds more precise; failing on it would turn a slow database into
 * a signed-out user.
 */
export async function resolveToken(token: string): Promise<SessionLookup> {
  const session = await sessionsRepository.findByTokenHash(hashToken(token));
  if (!session) return { ok: false, reason: 'unknown' };

  const now = Date.now();

  if (session.expires_at.getTime() <= now) {
    await sessionsRepository.deleteById(session.id);
    return { ok: false, reason: 'expired' };
  }

  const idleMs = now - session.last_active_at.getTime();
  if (idleMs > authConfig.session.idleTimeoutMinutes * MINUTE_MS) {
    await sessionsRepository.deleteById(session.id);
    return { ok: false, reason: 'idle' };
  }

  void sessionsRepository.touchLastActive(session.id).catch(() => {
    /* best-effort activity tracking — never blocks or fails a request */
  });

  return { ok: true, session };
}

export interface RotationResult {
  session: SessionRow;
  token: string;
  /** False when the presented token was still young enough to keep — the caller returns it unchanged. */
  rotated: boolean;
}

/**
 * Issues a replacement token for a still-valid session, if it is old enough.
 *
 * ## What rotation is for
 *
 * It bounds how long a *leaked* token stays useful without asking a present,
 * legitimate user to sign in again. The session's credential ages out; the
 * user's presence does not. This is the same protection a refresh token
 * provides, obtained without a second credential to store, transmit and revoke
 * — which is the whole reason this design keeps one opaque server-side token
 * rather than an access/refresh pair (server-side sessions are already
 * revocable, and revocability is what refresh tokens exist to approximate for
 * stateless JWTs).
 *
 * ## Why a young token is returned unchanged instead of always rotating
 *
 * The client calls this on launch and on 401. Rotating unconditionally would
 * mint a new token per app launch — churn with no security gain, and a widening
 * window for the one genuine hazard of rotation: a client that loses the
 * response after the server has already invalidated the old token would be
 * signed out through no fault of the user.
 *
 * Rejects rather than rotates an already-dead session: rotation must never be a
 * way to revive something the timeouts have ended.
 */
export async function rotateSession(token: string): Promise<RotationResult | null> {
  const lookup = await resolveToken(token);
  if (!lookup.ok) return null;

  const { session } = lookup;
  const ageMs = Date.now() - session.last_rotated_at.getTime();

  if (ageMs < authConfig.session.rotateAfterHours * HOUR_MS) {
    return { session, token, rotated: false };
  }

  const nextToken = generateSessionToken();
  const now = new Date();
  const updated = await sessionsRepository.rotateToken(session.id, hashToken(nextToken), now);

  // The row vanished between the lookup and the update — a concurrent logout or
  // revocation. Treated as a rejected rotation, never as a silent new session.
  if (!updated) return null;

  return { session: updated, token: nextToken, rotated: true };
}

/** Ends the session identified by [token] — the calling device only. Silent when the token is already unknown; logout is idempotent by nature. */
export async function revokeByToken(token: string): Promise<void> {
  await sessionsRepository.deleteByTokenHash(hashToken(token));
}

/**
 * Ends one specific session of [userId].
 *
 * Returns false when the session does not exist **or belongs to someone else** —
 * the two are deliberately indistinguishable, so that passing arbitrary ids
 * cannot be used to learn which ones are live.
 */
export async function revokeById(userId: number, sessionId: number): Promise<boolean> {
  const session = await sessionsRepository.findById(sessionId);
  if (!session || session.user_id !== userId) return false;
  await sessionsRepository.deleteById(sessionId);
  return true;
}

/**
 * Ends every session of [userId], optionally sparing the caller's own.
 *
 * Sparing is right for "sign out my other devices" — signing the person out as
 * a side effect of securing their account reads as a malfunction. It is wrong
 * after a password reset, where the whole point is that whoever else held a
 * session no longer does; that caller passes no exception.
 */
export async function revokeAllForUser(
  userId: number,
  exceptSessionId?: number,
): Promise<number> {
  return sessionsRepository.deleteAllByUserId(userId, exceptSessionId);
}

export function listSessions(userId: number): Promise<SessionRow[]> {
  return sessionsRepository.findActiveByUserId(userId);
}

/** Housekeeping for sessions whose owners never return — the per-request path already removes the ones that are presented. */
export function purgeExpired(): Promise<number> {
  return sessionsRepository.deleteExpired();
}
