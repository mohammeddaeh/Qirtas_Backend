import { eq } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { sessionsTable, type SessionRow, type NewSessionRow } from '../schemas/sessions.schema.js';

export async function insert(data: NewSessionRow): Promise<SessionRow> {
  const rows = await db.insert(sessionsTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function findByToken(token: string): Promise<SessionRow | undefined> {
  const rows = await db.select().from(sessionsTable).where(eq(sessionsTable.token, token)).limit(1);
  return rows[0];
}

export async function touchLastActive(id: number): Promise<void> {
  await db.update(sessionsTable).set({ last_active_at: new Date() }).where(eq(sessionsTable.id, id));
}

/**
 * Ends every session belonging to `userId`.
 *
 * Called after a password reset, and that is not housekeeping — it is the point.
 * The common reason someone resets a password is that someone else knows it;
 * leaving the attacker's existing session alive means the reset changed nothing
 * for them. The owner signs in again with the new password; the attacker does
 * not, because they do not have it.
 *
 * Not called on a voluntary password *change*, where the user is present and
 * signing every other device out would be a surprise rather than a protection.
 */
export async function deleteAllByUserId(userId: number): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.user_id, userId));
}

/** Logout — deletes the session row outright (sessions carry no historical/audit value once ended). */
export async function deleteByToken(token: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.token, token));
}
