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
    })
    .onConflictDoUpdate({
      target: devicePushTokensTable.token,
      set: {
        realm: params.realm,
        account_id: params.accountId,
        platform: params.platform,
        language: params.language,
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

/** FCM said these are dead (uninstalled / expired) — stop sending to them. */
export async function removeMany(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await db.delete(devicePushTokensTable).where(inArray(devicePushTokensTable.token, tokens));
}
