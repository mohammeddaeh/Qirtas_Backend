import { and, desc, eq, isNull, gt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  verificationTokensTable,
  type VerificationTokenRow,
  type VerificationPurpose,
} from '../schemas/verification-tokens.schema.js';

/** Row access for verification codes. Expiry, attempt ceilings and consumption rules live in verification.service.ts. */

export async function insert(data: {
  user_id: number;
  purpose: VerificationPurpose;
  token_hash: string;
  expires_at: Date;
}): Promise<VerificationTokenRow> {
  const rows = await db.insert(verificationTokensTable).values(data).returning();
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
  userId: number,
  purpose: VerificationPurpose,
): Promise<VerificationTokenRow | undefined> {
  const rows = await db
    .select()
    .from(verificationTokensTable)
    .where(
      and(
        eq(verificationTokensTable.user_id, userId),
        eq(verificationTokensTable.purpose, purpose),
        isNull(verificationTokensTable.consumed_at),
        gt(verificationTokensTable.expires_at, new Date()),
      ),
    )
    .orderBy(desc(verificationTokensTable.created_at))
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
  userId: number,
  purpose: VerificationPurpose,
): Promise<VerificationTokenRow | undefined> {
  const rows = await db
    .select()
    .from(verificationTokensTable)
    .where(
      and(
        eq(verificationTokensTable.user_id, userId),
        eq(verificationTokensTable.purpose, purpose),
      ),
    )
    .orderBy(desc(verificationTokensTable.created_at))
    .limit(1);
  return rows[0];
}

/** Burns every outstanding code for this (account, purpose) — called when a new one is issued, and when a code exhausts its attempts. */
export async function consumeAllPending(
  userId: number,
  purpose: VerificationPurpose,
  at: Date,
): Promise<void> {
  await db
    .update(verificationTokensTable)
    .set({ consumed_at: at })
    .where(
      and(
        eq(verificationTokensTable.user_id, userId),
        eq(verificationTokensTable.purpose, purpose),
        isNull(verificationTokensTable.consumed_at),
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
export async function incrementAttempts(id: number): Promise<number> {
  const rows = await db
    .update(verificationTokensTable)
    .set({ attempts: sql`${verificationTokensTable.attempts} + 1` })
    .where(eq(verificationTokensTable.id, id))
    .returning({ attempts: verificationTokensTable.attempts });
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
export async function consumeIfPending(id: number, at: Date): Promise<boolean> {
  const rows = await db
    .update(verificationTokensTable)
    .set({ consumed_at: at })
    .where(
      and(eq(verificationTokensTable.id, id), isNull(verificationTokensTable.consumed_at)),
    )
    .returning({ id: verificationTokensTable.id });
  return rows.length > 0;
}
