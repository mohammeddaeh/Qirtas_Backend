import { and, eq, ne, lt, gt, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  sessionsTable,
  type SessionRow,
  type NewSessionRow,
} from '../schemas/sessions.schema.js';

/**
 * Data access for sessions. No policy lives here — expiry rules, rotation
 * intervals and revocation reasons are session.service.ts's job; this file
 * only reads and writes rows.
 *
 * Moved from features/identity together with the schema (see that file's note).
 */

export async function insert(data: NewSessionRow): Promise<SessionRow> {
  const rows = await db.insert(sessionsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

/** Lookup is by digest — the plaintext token is never stored, so it is never searched for. */
export async function findByTokenHash(tokenHash: string): Promise<SessionRow | undefined> {
  const rows = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.token_hash, tokenHash))
    .limit(1);
  return rows[0];
}

export async function findById(id: number): Promise<SessionRow | undefined> {
  const rows = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).limit(1);
  return rows[0];
}

/**
 * Every live session for one account, newest activity first — backs the
 * "my devices" screen.
 *
 * Filters out rows already past their hard deadline rather than relying on the
 * sweep: a user opening this screen must not be shown a device that cannot
 * actually be used, and the sweep runs on a timer, not on their schedule.
 */
export async function findActiveByUserId(userId: number): Promise<SessionRow[]> {
  return db
    .select()
    .from(sessionsTable)
    .where(and(eq(sessionsTable.user_id, userId), gt(sessionsTable.expires_at, new Date())))
    .orderBy(desc(sessionsTable.last_active_at));
}

export async function touchLastActive(id: number): Promise<void> {
  await db.update(sessionsTable).set({ last_active_at: new Date() }).where(eq(sessionsTable.id, id));
}

/**
 * Replaces the stored digest and stamps the rotation.
 *
 * `created_at` is untouched by design — the absolute lifetime is measured from
 * first sign-in, so a session that rotates forever still dies on schedule.
 */
export async function rotateToken(
  id: number,
  tokenHash: string,
  rotatedAt: Date,
): Promise<SessionRow | undefined> {
  const rows = await db
    .update(sessionsTable)
    .set({ token_hash: tokenHash, last_rotated_at: rotatedAt, last_active_at: rotatedAt })
    .where(eq(sessionsTable.id, id))
    .returning();
  return rows[0];
}

export async function deleteById(id: number): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.id, id));
}

export async function deleteByTokenHash(tokenHash: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.token_hash, tokenHash));
}

/**
 * Ends every session belonging to [userId], optionally sparing one.
 *
 * `exceptSessionId` serves "sign out my other devices": the person issuing the
 * command is holding one of those sessions, and signing themselves out as a
 * side effect of securing their account reads as a malfunction.
 *
 * Called unsparingly after a password reset, and that is the point rather than
 * housekeeping — the usual reason someone resets a password is that somebody
 * else knows it, so leaving the other party's session alive means the reset
 * changed nothing for them.
 */
export async function deleteAllByUserId(
  userId: number,
  exceptSessionId?: number,
): Promise<number> {
  const rows = await db
    .delete(sessionsTable)
    .where(
      exceptSessionId === undefined
        ? eq(sessionsTable.user_id, userId)
        : and(eq(sessionsTable.user_id, userId), ne(sessionsTable.id, exceptSessionId)),
    )
    .returning({ id: sessionsTable.id });
  return rows.length;
}

/** Drops rows past their hard deadline. Idle expiry is handled per-request; this catches sessions nobody comes back to. */
export async function deleteExpired(): Promise<number> {
  const rows = await db
    .delete(sessionsTable)
    .where(lt(sessionsTable.expires_at, new Date()))
    .returning({ id: sessionsTable.id });
  return rows.length;
}

