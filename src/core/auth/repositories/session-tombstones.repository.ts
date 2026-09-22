import { and, eq, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { AuthRealm } from '../realm.js';
import { sessionTombstonesTable } from '../schemas/session-tombstones.schema.js';

/** Row access for `session_tombstones`. Why a reason is recorded, and when, is `session.service.ts`. */

export async function insertMany(
  realm: AuthRealm,
  rows: ReadonlyArray<{ tokenHash: string; expiresAt: Date }>,
  reason: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(sessionTombstonesTable)
    .values(
      rows.map((r) => ({
        realm: realm.id,
        token_hash: r.tokenHash,
        reason,
        expires_at: r.expiresAt,
      })),
    )
    .onConflictDoNothing();
}

export async function findReason(realm: AuthRealm, tokenHash: string): Promise<string | undefined> {
  const rows = await db
    .select({ reason: sessionTombstonesTable.reason })
    .from(sessionTombstonesTable)
    .where(
      and(eq(sessionTombstonesTable.realm, realm.id), eq(sessionTombstonesTable.token_hash, tokenHash)),
    )
    .limit(1);
  return rows[0]?.reason;
}

/** Past the session's own deadline the token would read "expired" anyway — nothing left to explain. */
export async function deleteExpired(): Promise<number> {
  const rows = await db
    .delete(sessionTombstonesTable)
    .where(lt(sessionTombstonesTable.expires_at, new Date()))
    .returning({ id: sessionTombstonesTable.id });
  return rows.length;
}
