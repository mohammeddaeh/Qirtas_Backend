import { accountStore } from '../ports/account-store.js';
import type { AuthProvider, ProviderIdentity } from '../ports/auth-provider.js';
import { verifyPassword, hashPassword } from '../services/password.service.js';

/**
 * Email + password, verified against the stored hash.
 *
 * The reference implementation of [AuthProvider] and, for now, the only one.
 * A Google or Keycloak provider is a sibling of this file: it validates a
 * different kind of evidence, returns the same [ProviderIdentity], and inherits
 * sessions, rotation, revocation, account-status rules and security events
 * unchanged — which is the entire reason the interface exists.
 */

export interface LocalCredentials {
  email: string;
  password: string;
}

class LocalAuthProvider implements AuthProvider<LocalCredentials> {
  readonly id = 'local';

  /**
   * ## Why an unknown address still costs a hash
   *
   * The obvious implementation returns early when no account matches, and in
   * doing so answers in a few milliseconds instead of the ~100 the KDF takes.
   * That difference is measurable over the network and turns this endpoint into
   * a membership oracle: an attacker learns which addresses are registered
   * without ever guessing a password — undoing the care the login service takes
   * to return one identical error for both cases.
   *
   * So a miss verifies the supplied password against a throwaway hash. The work
   * is wasted deliberately; the timing is the product.
   */
  async authenticate(credentials: LocalCredentials): Promise<ProviderIdentity | null> {
    const account = await accountStore().findByEmail(credentials.email);

    if (!account) {
      await verifyPassword(credentials.password, await decoyHash());
      return null;
    }

    const valid = await verifyPassword(credentials.password, account.passwordHash);
    if (!valid) return null;

    return {
      account,
      // A correct password proves knowledge of a secret, not control of a
      // mailbox. Only a provider that owns the address may vouch for it.
      emailVerifiedByProvider: false,
    };
  }
}

/**
 * A hash of a random value, computed once and reused.
 *
 * Once rather than per-request because deriving it is exactly the cost being
 * simulated, and paying it twice on a miss would make misses *slower* than
 * hits — the same leak with the sign flipped.
 */
let decoy: Promise<string> | undefined;
function decoyHash(): Promise<string> {
  decoy ??= hashPassword('decoy-for-constant-time-login-failure');
  return decoy;
}

export const localAuthProvider = new LocalAuthProvider();
