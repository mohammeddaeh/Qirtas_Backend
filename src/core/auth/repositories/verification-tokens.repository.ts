import { and, desc, eq, isNull, gt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type {
  VerificationTokenRow,
  VerificationPurpose,
} from '../schemas/verification-tokens.schema.js';
import type { AuthRealm } from '../realm.js';

/** Row access for verification codes. Expiry, attempt ceilings and consumption rules live in verification.service.ts. */

export async function insert(
  realm: AuthRealm,
  data: {
    user_id: number;
    purpose: VerificationPurpose;
    token_hash: string;
    expires_at: Date;
  },
): Promise<VerificationTokenRow> {
  const rows = await db.insert(realm.tokens).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

/**
 * The one code currently in play for this (account, purpose), if any.
 *
 * Newest first and unconsumed only. There should be at most one — issuing
 * invalidates its predecessors (see `consumeAllPending`) — but the ordering
 * makes the query correct rather than dependent on that invariant holding.
 */
export async function findPending(
  realm: AuthRealm,
  userId: number,
  purpose: VerificationPurpose,
): Promise<VerificationTokenRow | undefined> {
  const rows = await db
    .select()
    .from(realm.tokens)
    .where(
      and(
        eq(realm.tokens.user_id, userId),
        eq(realm.tokens.purpose, purpose),
        isNull(realm.tokens.consumed_at),
        gt(realm.tokens.expires_at, new Date()),
      ),
    )
    .orderBy(desc(realm.tokens.created_at))
    .limit(1);
  return rows[0];
}

/**
 * The most recent issue for this (account, purpose) regardless of state —
 * backs the resend cooldown.
 *
 * Must ignore consumption and expiry: the cooldown limits how often mail is
 * *sent*, and a code that was just used or just expired was still just sent.
 */
export async function findLatest(
  realm: AuthRealm,
  userId: number,
  purpose: VerificationPurpose,
): Promise<VerificationTokenRow | undefined> {
  const rows = await db
    .select()
    .from(realm.tokens)
    .where(and(eq(realm.tokens.user_id, userId), eq(realm.tokens.purpose, purpose)))
    .orderBy(desc(realm.tokens.created_at))
    .limit(1);
  return rows[0];
}

/** Burns every outstanding code for this (account, purpose) — called when a new one is issued, and when a code exhausts its attempts. */
export async function consumeAllPending(
  realm: AuthRealm,
  userId: number,
  purpose: VerificationPurpose,
  at: Date,
): Promise<void> {
  await db
    .update(realm.tokens)
    .set({ consumed_at: at })
    .where(
      and(
        eq(realm.tokens.user_id, userId),
        eq(realm.tokens.purpose, purpose),
        isNull(realm.tokens.consumed_at),
      ),
    );
}

/**
 * Records a failed guess and returns the new count.
 *
 * Incremented in the database (`attempts + 1`) rather than read-modify-written
 * in the service: two concurrent guesses would otherwise both read the same
 * value and write the same increment, so a parallel attacker would get twice
 * the attempts the ceiling allows.
 */
export async function incrementAttempts(realm: AuthRealm, id: number): Promise<number> {
  const rows = await db
    .update(realm.tokens)
    .set({ attempts: sql`${realm.tokens.attempts} + 1` })
    .where(eq(realm.tokens.id, id))
    .returning({ attempts: realm.tokens.attempts });
  return rows[0]?.attempts ?? 0;
}

/**
 * Marks [id] used, but only if it is still unused — the boolean says whether
 * this caller is the one that consumed it.
 *
 * The `IS NULL` guard is the single-use guarantee itself, not a convenience:
 * two requests arriving with the same valid code would otherwise both read it
 * as pending and both apply its effect. Only one `UPDATE` can match, so only
 * one caller is told it succeeded.
 */
export async function consumeIfPending(realm: AuthRealm, id: number, at: Date): Promise<boolean> {
  const rows = await db
    .update(realm.tokens)
    .set({ consumed_at: at })
    .where(and(eq(realm.tokens.id, id), isNull(realm.tokens.consumed_at)))
    .returning({ id: realm.tokens.id });
  return rows.length > 0;
}
