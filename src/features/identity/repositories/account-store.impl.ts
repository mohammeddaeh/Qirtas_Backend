import { eq } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import type {
  AccountStore,
  AuthAccount,
  NewAuthAccount,
  SignInDecision,
} from '../../../core/auth/ports/account-store.js';
import { BusinessError } from '../../../core/http/api-error.js';
import { usersTable, type UserRow } from '../schemas/users.schema.js';
import * as usersRepository from './users.repository.js';

/**
 * Qirtas's implementation of the authentication engine's one required port.
 *
 * This file is the entire seam. Everything Qirtas-specific about accounts —
 * that a `users` row carries a branch request and an ownership percentage, that
 * `pending_approval` may sign in but `suspended` may not, that verifying an
 * address advances the account into the review queue — is stated here, and
 * `core/auth` stays ignorant of all of it.
 *
 * Moving the engine to another application means writing this file again for
 * that application's user table. Nothing else.
 */

/** The seven facts `core/auth` needs, projected out of a twenty-column row. */
function toAuthAccount(row: UserRow): AuthAccount {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    status: row.status,
  };
}

class QirtasAccountStore implements AccountStore {
  async findByEmail(email: string): Promise<AuthAccount | undefined> {
    const row = await usersRepository.findByEmail(email);
    return row ? toAuthAccount(row) : undefined;
  }

  async findById(id: number): Promise<AuthAccount | undefined> {
    const row = await usersRepository.findById(id);
    return row ? toAuthAccount(row) : undefined;
  }

  /**
   * Creates a Qirtas user from the engine's account fields plus this
   * application's own profile fields.
   *
   * `profile` is opaque to `core/auth` and read here — the keys are Qirtas's
   * (`first_name`, `phone`, `requested_role_id`, …). Unknown keys are ignored
   * rather than rejected: the caller is always this codebase, and a strict
   * check would just be a second validation of what zod already validated at
   * the route.
   */
  async create(data: NewAuthAccount): Promise<AuthAccount> {
    // ## Why this list is short, and must stay short
    //
    // `profile` is `Record<string, unknown>` — whatever the caller put in it.
    // Every key named here is a key a caller can set; every key NOT named here
    // is unreachable, because nothing reads it.
    //
    // `is_admin`, `decided_at` and `decided_by_user_id` were removed from this
    // list on 2026-08-11 during the security review. No caller set them (the
    // only caller is `registerStaff`, which builds this object from literals),
    // but accepting them meant the day someone wrote the natural-looking
    // `profile: { ...body }`, an `is_admin: true` in a **public registration
    // body** would have created an administrator. Admin-created accounts and
    // the first-run bootstrap set those fields through `usersRepository.insert`
    // directly, on paths that are already permission-gated.
    //
    // ⚠️ `status` is the one privileged key that remains, because
    // `registerStaff` genuinely computes it. Never widen its source to request
    // input: `status: 'active'` would skip BOTH email verification and admin
    // approval in one field.
    const profile = data.profile as {
      first_name?: string;
      last_name?: string;
      phone?: string;
      status?: UserRow['status'];
      requested_role_id?: number | null;
      requested_branch_id?: number | null;
      requested_ownership_percentage?: number | null;
    };

    try {
      const row = await usersRepository.insert({
        first_name: profile.first_name ?? '',
        last_name: profile.last_name ?? '',
        email: data.email,
        phone: profile.phone ?? '',
        password_hash: data.passwordHash,
        email_verified_at: data.emailVerifiedAt,
        status: profile.status ?? 'pending_verification',
        requested_role_id: profile.requested_role_id ?? null,
        requested_branch_id: profile.requested_branch_id ?? null,
        requested_ownership_percentage:
          profile.requested_ownership_percentage != null
            ? profile.requested_ownership_percentage.toFixed(2)
            : null,
        // `is_admin` / `decided_at` / `decided_by_user_id` are deliberately NOT
        // settable here — see the note above `profile`. They default from the
        // schema (`is_admin: false`), which is the correct value for every
        // account this path creates.
      });
      return toAuthAccount(row);
    } catch (err) {
      // The unique index is the only thing that actually holds: a
      // check-then-insert is a race two simultaneous registrations can lose
      // together. Translated here so callers see the application's own 409
      // rather than a driver error.
      if (isUniqueViolation(err)) {
        throw new BusinessError(409, 'An account with this email already exists', 'email_taken');
      }
      throw err;
    }
  }

  async updatePasswordHash(accountId: number, passwordHash: string): Promise<void> {
    await usersRepository.update(accountId, { password_hash: passwordHash });
  }

  /**
   * Stamps the proof and advances the lifecycle in one write.
   *
   * The status move is Qirtas's rule, which is exactly why it belongs in this
   * file: proving an address is the engine's business, and what that unlocks is
   * the application's. A registration only reaches the admin review queue here,
   * which is what makes the queue un-floodable by addresses nobody owns.
   *
   * Guarded on the current status rather than applied unconditionally: an
   * `active` user verifying a changed address must not be demoted back into the
   * approval queue. Only an account still waiting on verification moves.
   */
  async markEmailVerified(accountId: number, verifiedAt: Date): Promise<void> {
    const row = await usersRepository.findById(accountId);
    if (!row) return;

    await db
      .update(usersTable)
      .set({
        email_verified_at: verifiedAt,
        ...(row.status === 'pending_verification' ? { status: 'pending_approval' as const } : {}),
      })
      .where(eq(usersTable.id, accountId));
  }

  /**
   * Whether this account may open a session, and what to say if not.
   *
   * ## Why `pending_approval` and `pending_verification` are allowed in
   *
   * Both get a real session, and it unlocks nothing: `requirePermission()`
   * resolves active `UserRoleAssignment` rows, and neither status ever has one.
   * What the session does allow is the account being *reachable* — seeing its
   * own status, entering a verification code, reading a rejection reason and
   * resubmitting — after the app has been reinstalled and the original
   * registration response is long gone. Refusing sign-in would leave those
   * people with an account they can neither use nor recover.
   *
   * `rejected` is likewise admitted, for the same reason it always was: the
   * person must be able to read why and submit a new request.
   *
   * ## Why the refusals name themselves
   *
   * Each carries `account_status` in `data`, which is what the Flutter client
   * already branches on to pick a screen. Matching translated prose to tell
   * refusals apart breaks the first time a word changes.
   */
  canSignIn(account: AuthAccount): SignInDecision {
    switch (account.status) {
      case 'suspended':
        return {
          allowed: false,
          reasonKey: 'account_suspended',
          reason: 'Your account is temporarily suspended',
          data: { account_status: 'suspended' },
        };
      case 'disabled':
        return {
          allowed: false,
          reasonKey: 'account_disabled',
          reason: 'Your account has been disabled',
          data: { account_status: 'disabled' },
        };
      default:
        break;
    }

    // An unverified address is deliberately NOT a refusal, even when
    // verification is `required`.
    //
    // Signing the person out would leave them with an account they cannot use
    // and cannot fix: the code screen is inside the app, and reaching it needs
    // a session. Enforcement does not depend on blocking the door — an
    // unverified account never advances to `pending_approval`, so it is never
    // approved, so it never holds an assignment, so `requirePermission()`
    // refuses it everything. The gate is at the queue, where it is effective,
    // rather than at sign-in, where it would only be visible.
    //
    // The client learns the state from `email_verified_at` on the user object
    // and routes to the code screen itself.
    return { allowed: true };
  }
}

/** PostgreSQL `unique_violation`. Matched on the code, not the message, which is localised and version-dependent. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
  );
}

export const qirtasAccountStore = new QirtasAccountStore();
