import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accountEmailsTable } from './schemas/account-emails.schema.js';
import type { RealmId } from './realm.js';
import type { RequestOrigin } from './services/auth.service.js';

/**
 * One sign-in endpoint for every population.
 *
 * The person typing an email does not know — and must not need to know — that
 * the system keeps staff and customers in separate tables. The server decides
 * which realm the address belongs to (`account_emails`, the one place both are
 * visible) and hands the request to that realm's own login.
 *
 * ## Why handlers are registered instead of imported
 *
 * A realm's login builds a payload with that realm's own facts — staff get
 * `permission_keys`, customers get a profile. `core/auth` cannot import those
 * (it would learn that roles exist), and the two features cannot import each
 * other. So each is registered at composition time, where both are visible.
 *
 * ## Why an unknown address still gets a login attempt
 *
 * It falls through to the staff handler, which runs the constant-time decoy
 * hash and answers with the same `invalid_credentials` as a wrong password.
 * Answering early would make "no such account" measurably faster than "wrong
 * password" — the membership oracle the engine already goes out of its way to
 * avoid.
 */

export interface LoginRequest {
  email: string;
  password: string;
  device_info?: string | undefined;
}

export type LoginHandler = (
  body: LoginRequest,
  origin: RequestOrigin,
) => Promise<object>;

const handlers = new Map<RealmId, LoginHandler>();

export function registerLoginHandler(realm: RealmId, handler: LoginHandler): void {
  handlers.set(realm, handler);
}

/** Which realm holds [email]. Undefined when nobody does. */
export async function realmForEmail(email: string): Promise<RealmId | undefined> {
  const rows = await db
    .select({ realm: accountEmailsTable.realm })
    .from(accountEmailsTable)
    .where(eq(accountEmailsTable.email, email.toLowerCase()))
    .limit(1);
  return rows[0]?.realm;
}

export async function loginAny(
  body: LoginRequest,
  origin: RequestOrigin,
): Promise<object> {
  const realm = (await realmForEmail(body.email)) ?? 'staff';
  const handler = handlers.get(realm);
  if (!handler) throw new Error(`No login handler registered for realm '${realm}'.`);
  return handler(body, origin);
}
