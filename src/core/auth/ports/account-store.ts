/**
 * The only thing an application must implement per realm to use this authentication
 * engine.
 *
 * ## Why this port exists at all
 *
 * `core/auth` needs to read and write exactly seven facts about an account:
 * its id, its email, its password hash, whether that email is proven, whether
 * sign-in is currently permitted, and the two timestamps around verification.
 * Every application has those seven. What no two applications share is the
 * table they live in — Qirtas's `users` carries twenty columns of branch,
 * ownership and approval-workflow data; a storefront's carries a shipping
 * address; a template's carries neither.
 *
 * Without this interface `core/auth` would import Qirtas's concrete schema, and
 * the module would stop being portable the moment it was written — which is the
 * one thing this whole layer exists to prevent. With it, moving the engine to
 * another app is: write one file, implement seven methods.
 *
 * ## Why it is a port and not "just use the repository"
 *
 * The direction matters. `features/identity` owns the `users` table and depends
 * on `core/auth`; if `core/auth` depended back on `features/identity` the two
 * would be one module wearing two names, and the project's `features → features
 * ❌` rule would be violated transitively. The dependency points one way:
 * identity implements this, core/auth consumes it, neither imports the other's
 * internals.
 *
 * ## What deliberately is NOT here
 *
 * No roles, no permissions, no branches, no profile fields, no listing, no
 * search. Those are authorization and business concerns and they stay in the
 * application. If a method here ever needs a role to answer, the method is in
 * the wrong layer.
 */

/**
 * The authentication-relevant projection of an account.
 *
 * Deliberately NOT the application's user row: an implementation maps its own
 * row down to this. That mapping is the seam — it is what lets an app rename
 * `password_hash` or store verification in a side table without `core/auth`
 * ever knowing.
 */
export interface AuthAccount {
  id: number;
  email: string;
  /** The stored hash, in whatever format `core/auth/services/password.service.ts` produces. */
  passwordHash: string;
  /** `null` until the address is proven. The timestamp, not a boolean — "when" answers questions "whether" cannot. */
  emailVerifiedAt: Date | null;
  /**
   * Free-form application status, passed through untouched.
   *
   * `core/auth` never interprets this string; it only hands it back to
   * [canSignIn] and includes it in refusal payloads so a client can branch on
   * it. Qirtas puts `'active' | 'suspended' | …` here; another app may put
   * something else entirely.
   */
  status: string;
}

/**
 * Whether an account may open a session right now, and why not if not.
 *
 * Returned by the application because the rule is the application's: Qirtas
 * lets a `pending_approval` account sign in (it must be able to see its own
 * status and resubmit) but refuses a `suspended` one. A different app may
 * reverse both. `core/auth` only enforces the answer.
 */
export interface SignInDecision {
  allowed: boolean;
  /**
   * Machine-readable refusal reason — becomes the `message_key` on the 403 and
   * the discriminator the Flutter client already branches on
   * (`ApiError.data.account_status`). Required when `allowed` is false.
   */
  reasonKey?: string;
  /** Human-readable English fallback for logs and unsupported languages. */
  reason?: string;
  /** Extra payload merged into the error's `data` — e.g. `{ account_status: 'suspended' }`. */
  data?: Record<string, unknown>;
}

/** Fields an application must accept when `core/auth` creates an account. */
export interface NewAuthAccount {
  email: string;
  passwordHash: string;
  /** Pre-verified accounts (admin-created, seeded, imported) pass a timestamp. */
  emailVerifiedAt: Date | null;
  /**
   * Application-defined extras — name, phone, requested role, anything.
   *
   * Opaque to `core/auth`, which never reads a key from it. It exists so an app
   * can create an account through one entry point instead of two half-creates,
   * and the implementation is free to reject anything it does not recognise.
   */
  profile: Record<string, unknown>;
}

export interface AccountStore {
  findByEmail(email: string): Promise<AuthAccount | undefined>;

  findById(id: number): Promise<AuthAccount | undefined>;

  /**
   * Creates the account and returns its authentication projection.
   *
   * Throws if the email is taken — `core/auth` does not pre-check, because a
   * check followed by an insert is a race, and the unique index is the only
   * thing that actually holds. Implementations should surface the collision as
   * the application's own 409.
   */
  create(data: NewAuthAccount): Promise<AuthAccount>;

  /** Replaces the stored password hash. Never called with a plaintext value. */
  updatePasswordHash(accountId: number, passwordHash: string): Promise<void>;

  /**
   * Records that the address is proven, at [verifiedAt].
   *
   * Implementations may also advance their own lifecycle here — Qirtas moves
   * `pending_verification → pending_approval` in the same write, which is
   * exactly the point of the hook: the transition is the application's rule,
   * the proof is `core/auth`'s.
   */
  markEmailVerified(accountId: number, verifiedAt: Date): Promise<void>;

  /** See [SignInDecision]. Consulted on every sign-in AND on every request by the auth middleware. */
  canSignIn(account: AuthAccount): Promise<SignInDecision> | SignInDecision;
}
