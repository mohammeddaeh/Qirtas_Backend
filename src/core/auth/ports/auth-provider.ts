/**
 * How an identity is *proven*. Not what it is allowed to do.
 *
 * ## The one question this interface answers
 *
 * "Given this evidence, which account is the caller?" — and nothing else.
 * Session creation, status checks, rate limiting, audit and refresh are common
 * to every provider and live in `auth.service.ts`, above this line. That split
 * is the whole design: adding Google means writing an `authenticate()` that
 * validates an ID token, and inheriting sessions, revocation, security events
 * and the account-status rules for free.
 *
 * ## Why it is this small
 *
 * A fuller "provider" abstraction — one that also owned linking, refresh, token
 * exchange and user provisioning — would be three interfaces and a lifecycle,
 * and today it would have exactly one implementation. This project's rule is to
 * abstract what actually varies. What varies between local, Google, Apple and
 * Keycloak is *how you check the evidence*; everything downstream is identical.
 * If a second provider later proves that assumption wrong, this interface grows
 * then, with a real case to grow it against.
 *
 * ## What a provider must never do
 *
 * - Create a session (only `auth.service.ts` does).
 * - Decide whether a suspended account may sign in (that is `AccountStore.canSignIn`).
 * - Trust the client for `emailVerified` — see the field's own note.
 */

import type { AuthAccount } from './account-store.js';
import type { AuthRealm } from '../realm.js';

/** What a successful proof yields. */
export interface ProviderIdentity {
  /** The account this evidence proves. */
  account: AuthAccount;
  /**
   * Whether THIS provider independently vouches for the email address.
   *
   * An external identity provider that owns the mailbox (Google for a
   * `@gmail.com` address) genuinely proves it, and an account signing in that
   * way needs no verification code from us. The local password provider proves
   * only knowledge of a password, which says nothing about the address — so it
   * returns `false` and the account's own `emailVerifiedAt` remains the only
   * evidence.
   *
   * Never populated from anything the client sent. A client-supplied
   * "email_verified: true" is an attacker-supplied one.
   */
  emailVerifiedByProvider: boolean;
}

export interface AuthProvider<TCredentials = unknown> {
  /** Stable identifier — `'local'`, `'google'`, `'keycloak'`. Recorded on the session so "how did this device sign in?" has an answer. */
  readonly id: string;

  /**
   * Returns the proven identity, or `null` when the evidence does not check out.
   *
   * `null`, not an exception, for a failed proof: a wrong password is an
   * expected outcome, and the caller must answer it identically to an unknown
   * address (see `auth.service.ts` — the two are indistinguishable to the
   * client on purpose). Exceptions stay for genuine faults — an unreachable
   * identity provider, a malformed configuration.
   */
  authenticate(realm: AuthRealm, credentials: TCredentials): Promise<ProviderIdentity | null>;
}

/**
 * The registry.
 *
 * A map rather than a single slot because providers coexist — an app offering
 * both password and Google sign-in serves both at once, unlike the account
 * store or the mail transport where exactly one is correct.
 */
const providers = new Map<string, AuthProvider>();

export function registerAuthProvider(provider: AuthProvider<never>): void {
  providers.set(provider.id, provider as AuthProvider);
}

export function getAuthProvider(id: string): AuthProvider | undefined {
  return providers.get(id);
}

/** Which sign-in methods this deployment actually serves — the honest answer for a `GET /auth/providers` or a client feature flag. */
export function registeredProviderIds(): string[] {
  return [...providers.keys()];
}
