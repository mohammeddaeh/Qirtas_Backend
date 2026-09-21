import { and, eq } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { accountEmailsTable } from '../schemas/account-emails.schema.js';
import type { RealmId } from '../realm.js';

/**
 * Writers for the cross-realm email uniqueness claim.
 *
 * Every function takes the caller's transaction, never the global `db`: the
 * claim is only correct if it commits or rolls back with the account row it
 * describes. A unique violation surfaces as PostgreSQL `23505`, which the
 * account stores already translate into their own 409.
 */

/** A drizzle transaction or the client itself — both expose the same query builder. */
export type Executor = Pick<typeof db, 'insert' | 'update' | 'delete'>;

export async function claim(
  tx: Executor,
  realm: RealmId,
  email: string,
  accountId: number,
): Promise<void> {
  await tx
    .insert(accountEmailsTable)
    .values({ email: email.toLowerCase(), realm, account_id: accountId });
}

/** Re-points the claim after an email change. Throws `23505` if the new address is held by anyone. */
export async function move(
  tx: Executor,
  realm: RealmId,
  accountId: number,
  newEmail: string,
): Promise<void> {
  await tx
    .update(accountEmailsTable)
    .set({ email: newEmail.toLowerCase() })
    .where(and(eq(accountEmailsTable.realm, realm), eq(accountEmailsTable.account_id, accountId)));
}

export async function release(tx: Executor, realm: RealmId, accountId: number): Promise<void> {
  await tx
    .delete(accountEmailsTable)
    .where(and(eq(accountEmailsTable.realm, realm), eq(accountEmailsTable.account_id, accountId)));
}
