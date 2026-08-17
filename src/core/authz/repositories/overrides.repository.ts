import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  userPermissionOverridesTable,
  type UserPermissionOverrideRow,
} from '../schemas/user-permission-overrides.schema.js';
import type { OverrideInput } from '../inference.js';

/** Row access for per-account exceptions. No rules here — every rule is in `inference.ts`. */

export function findForUser(userId: number): Promise<UserPermissionOverrideRow[]> {
  return db
    .select()
    .from(userPermissionOverridesTable)
    .where(eq(userPermissionOverridesTable.user_id, userId));
}

/**
 * What the resolver needs, and nothing more — the two fields a rule reads.
 *
 * A separate query from [findForUser] so the hot path (every guarded request)
 * does not carry `note` and two timestamps it will never look at.
 */
export async function findEffectsForUser(userId: number): Promise<OverrideInput[]> {
  const rows = await db
    .select({
      permission_key: userPermissionOverridesTable.permission_key,
      effect: userPermissionOverridesTable.effect,
    })
    .from(userPermissionOverridesTable)
    .where(eq(userPermissionOverridesTable.user_id, userId));
  return rows;
}

/**
 * Replaces the account's whole override set, in one transaction.
 *
 * Delete-then-insert rather than a computed diff: the screen sends the state it
 * wants, and a diff would be more code producing the same rows. The transaction
 * matters — an account briefly holding *no* overrides would, for that instant,
 * have every deny lifted, and a concurrent request could slip through a gate
 * the administrator never opened.
 */
export async function replaceForUser(
  userId: number,
  overrides: Array<{ key: string; effect: 'allow' | 'deny'; note?: string | null }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(userPermissionOverridesTable)
      .where(eq(userPermissionOverridesTable.user_id, userId));

    if (overrides.length === 0) return;

    await tx.insert(userPermissionOverridesTable).values(
      overrides.map((o) => ({
        user_id: userId,
        permission_key: o.key,
        effect: o.effect,
        note: o.note ?? null,
      })),
    );
  });
}
