import type { AccountStore } from './ports/account-store.js';
import type { sessionsTable } from './schemas/sessions.schema.js';
import type { verificationTokensTable } from './schemas/verification-tokens.schema.js';

/**
 * A **realm** is one population of accounts with its own credentials storage:
 * (account store · sessions table · verification-tokens table), registered
 * together at composition time.
 *
 * ## Why realms, and not a `realm` column on one sessions table
 *
 * Staff (`users`) and customers (`customers`) are separate tables on purpose
 * (docs/reference/customer_accounts.md §2). A session must therefore point at
 * the right one with a real foreign key — otherwise deleting an account leaves
 * live credentials behind, which is worse than one extra table.
 *
 * The security payoff is the reason to prefer this: a customer token presented
 * to a staff route is looked up in the staff sessions table, where it does not
 * exist, so it is a plain 401 — no "if realm !== staff" check anyone could
 * forget to write.
 *
 * The table types below are the staff ones; a second realm's tables are
 * structurally identical and are cast to them once, where they are declared.
 */

export type RealmId = 'staff' | 'customer';

export interface AuthRealm {
  readonly id: RealmId;
  readonly store: AccountStore;
  readonly sessions: typeof sessionsTable;
  readonly tokens: typeof verificationTokensTable;
  /**
   * Prefix of every session token issued in this realm ('' for staff, whose
   * tokens predate realms and must keep working). Lets the auth middleware
   * pick the one table to probe instead of trying each.
   */
  readonly tokenPrefix: string;
}

const realms = new Map<RealmId, AuthRealm>();

export function registerRealm(realm: AuthRealm): void {
  realms.set(realm.id, realm);
}

export function getRealm(id: RealmId): AuthRealm {
  const realm = realms.get(id);
  if (!realm) {
    // Loud at boot rather than a null-deref deep inside a request.
    throw new Error(
      `Auth realm '${id}' has not been registered. Call configureAuth({ realms }) during composition.`,
    );
  }
  return realm;
}

export function staffRealm(): AuthRealm {
  return getRealm('staff');
}

/** The realm a bearer token belongs to, decided by its prefix alone — no database read. */
export function realmForToken(token: string): AuthRealm | undefined {
  // Longest non-empty prefix wins; the empty prefix (staff) is the fallback.
  let fallback: AuthRealm | undefined;
  for (const realm of realms.values()) {
    if (realm.tokenPrefix === '') {
      fallback = realm;
    } else if (token.startsWith(realm.tokenPrefix)) {
      return realm;
    }
  }
  return fallback;
}
