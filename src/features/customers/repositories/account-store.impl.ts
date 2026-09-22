import type {
  AccountStore,
  AuthAccount,
  NewAuthAccount,
  SignInDecision,
} from '../../../core/auth/ports/account-store.js';
import { BusinessError } from '../../../core/http/api-error.js';
import type { CustomerRow } from '../schemas/customers.schema.js';
import { TERMS_VERSION } from '../terms-version.js';
import * as customersRepository from './customers.repository.js';

/**
 * The customer realm's implementation of the engine's port.
 *
 * ## Two rules that differ from the staff store, on purpose
 *
 * 1. **An unverified address may sign in.** Staff verification guards the admin
 *    review queue; customers have no queue. The gate here is *purchasing*
 *    (`requireVerified`), so browsing and account setup work immediately.
 * 2. **`markEmailVerified` advances nothing.** There is no lifecycle state to
 *    move — the timestamp is the whole fact.
 */

function toAuthAccount(row: CustomerRow): AuthAccount {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    status: row.status,
  };
}

class CustomerAccountStore implements AccountStore {
  async findByEmail(email: string): Promise<AuthAccount | undefined> {
    const row = await customersRepository.findByEmail(email);
    return row ? toAuthAccount(row) : undefined;
  }

  async findById(id: number): Promise<AuthAccount | undefined> {
    const row = await customersRepository.findById(id);
    return row ? toAuthAccount(row) : undefined;
  }

  async create(data: NewAuthAccount): Promise<AuthAccount> {
    // Only the keys named here are reachable from `profile` — same reasoning as
    // the staff store: never widen this to `...profile`, or a registration body
    // could set `customer_type: 'wholesale'` / `status` and skip approval.
    const profile = data.profile as {
      first_name?: string;
      last_name?: string;
      phone?: string | null;
      preferred_branch_id?: number | null;
      terms_accepted?: boolean;
      language?: string | null;
    };

    try {
      const row = await customersRepository.insert({
        first_name: profile.first_name ?? '',
        last_name: profile.last_name ?? '',
        email: data.email,
        phone: profile.phone ?? null,
        password_hash: data.passwordHash,
        email_verified_at: data.emailVerifiedAt,
        preferred_branch_id: profile.preferred_branch_id ?? null,
        preferred_language: profile.language ?? null,
        ...(profile.terms_accepted
          ? { terms_accepted_at: new Date(), terms_version: TERMS_VERSION }
          : {}),
      });
      return toAuthAccount(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BusinessError(409, 'An account with this email already exists', 'email_taken');
      }
      throw err;
    }
  }

  async updatePasswordHash(accountId: number, passwordHash: string): Promise<void> {
    await customersRepository.update(accountId, { password_hash: passwordHash });
  }

  async markEmailVerified(accountId: number, verifiedAt: Date): Promise<void> {
    await customersRepository.update(accountId, { email_verified_at: verifiedAt });
  }

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
        return { allowed: true };
    }
  }
}

/** PostgreSQL `unique_violation`, matched on the code — the message is localised. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export const customerAccountStore = new CustomerAccountStore();
