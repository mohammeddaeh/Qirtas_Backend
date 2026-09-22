import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { RealmId } from '../../auth/realm.js';
import { devicePushTokensTable, type DevicePushTokenRow } from '../schemas/device-push-tokens.schema.js';

/** Registers a device for [accountId], **moving it** if another account held it. */
export async function upsert(params: {
  realm: RealmId;
  accountId: number;
  token: string;
  platform: string;
  language: string | null;
  sessionId: number | null;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(devicePushTokensTable)
    .values({
      realm: params.realm,
      account_id: params.accountId,
      token: params.token,
      platform: params.platform,
      language: params.language,
      session_id: params.sessionId,
    })
    .onConflictDoUpdate({
      target: devicePushTokensTable.token,
      set: {
        realm: params.realm,
        account_id: params.accountId,
        platform: params.platform,
        language: params.language,
        session_id: params.sessionId,
        last_seen_at: now,
      },
    });
}

export async function findByAccount(
  realm: RealmId,
  accountId: number,
): Promise<DevicePushTokenRow[]> {
  return db
    .select()
    .from(devicePushTokensTable)
    .where(and(eq(devicePushTokensTable.realm, realm), eq(devicePushTokensTable.account_id, accountId)));
}

/**
 * Removes [token] **only if it still belongs to** [accountId]. Sign-out of an
 * old session arriving after the phone changed hands must not unregister the new
 * owner's device.
 */
export async function removeOwned(
  realm: RealmId,
  accountId: number,
  token: string,
): Promise<void> {
  await db
    .delete(devicePushTokensTable)
    .where(
      and(
        eq(devicePushTokensTable.token, token),
        eq(devicePushTokensTable.realm, realm),
        eq(devicePushTokensTable.account_id, accountId),
      ),
    );
}

/**
 * Every device of an account that is being **deleted** — run inside the delete
 * transaction by the caller.
 *
 * There is no FK to cascade from (the row points at one of two tables), so
 * without this the rows outlived the account. Self-delete is where it showed:
 * the device a customer deleted their account on stayed registered to an id
 * that no longer exists, and nothing ever removed it — no sign-out follows a
 * deletion, and FCM only reports a token dead once the app is uninstalled.
 */
export async function removeAllForAccount(
  tx: Pick<typeof db, 'delete'>,
  realm: RealmId,
  accountId: number,
): Promise<void> {
  await tx
    .delete(devicePushTokensTable)
    .where(and(eq(devicePushTokensTable.realm, realm), eq(devicePushTokensTable.account_id, accountId)));
}

/** FCM said these are dead (uninstalled / expired) — stop sending to them. */
export async function removeMany(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await db.delete(devicePushTokensTable).where(inArray(devicePushTokensTable.token, tokens));
}
