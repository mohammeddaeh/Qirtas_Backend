import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { BusinessError, UnauthorizedError } from '../../http/api-error.js';
import {
  accountMfaRecoveryCodesTable,
  accountMfaTable,
  type AccountMfaRow,
} from '../schemas/mfa.schema.js';
import type { RealmId } from '../realm.js';
import { generateSecret, base32Encode, matchStep, otpauthUri } from './totp.js';
import { open, seal } from './secret-box.js';
import { issueChallenge } from './challenge.js';

/**
 * The second factor: enrollment, verification, recovery.
 *
 * ## Who decides who *must* have one
 *
 * Not this file. "Super admin and branch managers" is a fact about roles, and
 * `core/auth` must not know roles exist — so the application registers a
 * [MfaPolicy] at composition time. This engine only answers "is it enrolled"
 * and "is this code right".
 *
 * ## Why a wrong code locks the account and not the IP
 *
 * A 6-digit code has a million values; five wrong guesses per window make
 * brute force pointless, but only if the counter is on the *account* — an
 * attacker holding the password can rotate addresses freely.
 */

export interface MfaPolicy {
  /** Whether this account is *required* to hold a second factor. */
  isRequired(realm: RealmId, accountId: number): Promise<boolean>;
}

let policy: MfaPolicy = { isRequired: async () => false };
export function setMfaPolicy(p: MfaPolicy): void {
  policy = p;
}

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODE_COUNT = 10;
const ISSUER = 'Qirtas';

/** Thrown by sign-in when the password was right but a code is still owed. */
export class SecondFactorRequired extends Error {
  constructor(public readonly challenge: string) {
    super('Second factor required');
  }
}

async function findRow(realm: RealmId, accountId: number): Promise<AccountMfaRow | undefined> {
  const rows = await db
    .select()
    .from(accountMfaTable)
    .where(and(eq(accountMfaTable.realm, realm), eq(accountMfaTable.account_id, accountId)))
    .limit(1);
  return rows[0];
}

export async function isEnrolled(realm: RealmId, accountId: number): Promise<boolean> {
  return (await findRow(realm, accountId))?.confirmed_at != null;
}

export async function challengeIfEnrolled(
  realm: RealmId,
  accountId: number,
): Promise<string | null> {
  return (await isEnrolled(realm, accountId)) ? issueChallenge(realm, accountId) : null;
}

export async function isRequired(realm: RealmId, accountId: number): Promise<boolean> {
  return policy.isRequired(realm, accountId);
}

export interface MfaStatus {
  enrolled: boolean;
  required: boolean;
  recovery_codes_remaining: number;
}

export async function status(realm: RealmId, accountId: number): Promise<MfaStatus> {
  const [enrolled, required, remaining] = await Promise.all([
    isEnrolled(realm, accountId),
    isRequired(realm, accountId),
    countRecoveryCodes(realm, accountId),
  ]);
  return { enrolled, required, recovery_codes_remaining: remaining };
}

/**
 * Starts (or restarts) enrollment. Refused once confirmed: silently replacing a
 * working authenticator would let anyone holding a stolen session swap the
 * second factor for their own — disable/reset is the deliberate path.
 */
export async function beginEnrollment(
  realm: RealmId,
  accountId: number,
  accountLabel: string,
): Promise<{ secret: string; otpauth_uri: string }> {
  const existing = await findRow(realm, accountId);
  if (existing?.confirmed_at) {
    throw new BusinessError(409, 'Two-factor authentication is already set up', 'mfa_already_enrolled');
  }
  const secret = generateSecret();
  const values = {
    realm,
    account_id: accountId,
    secret_sealed: seal(secret),
    confirmed_at: null,
    last_used_step: null,
    failed_attempts: 0,
    locked_until: null,
  };
  await db
    .insert(accountMfaTable)
    .values(values)
    .onConflictDoUpdate({
      target: [accountMfaTable.realm, accountMfaTable.account_id],
      set: values,
    });
  return {
    secret: base32Encode(secret),
    otpauth_uri: otpauthUri({ secret, account: accountLabel, issuer: ISSUER }),
  };
}

/** Proves the phone works, activates the factor, and returns the recovery codes — **shown once**. */
export async function confirmEnrollment(
  realm: RealmId,
  accountId: number,
  code: string,
): Promise<string[]> {
  const row = await findRow(realm, accountId);
  if (!row) throw new BusinessError(409, 'Start setup first', 'mfa_not_started');
  if (row.confirmed_at) {
    throw new BusinessError(409, 'Two-factor authentication is already set up', 'mfa_already_enrolled');
  }
  const step = matchStep(open(row.secret_sealed), code, new Date());
  if (step === null) throw new UnauthorizedError('Invalid code', 'mfa_code_invalid');
  await db
    .update(accountMfaTable)
    .set({ confirmed_at: new Date(), last_used_step: step })
    .where(and(eq(accountMfaTable.realm, realm), eq(accountMfaTable.account_id, accountId)));
  return regenerateRecoveryCodes(realm, accountId);
}

function hashRecovery(code: string): string {
  return createHash('sha256').update(code.replace(/-/g, '').toUpperCase()).digest('hex');
}

function newRecoveryCode(): string {
  // 10 chars of an unambiguous alphabet, grouped for reading aloud: ABCDE-FGHJK.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export async function regenerateRecoveryCodes(
  realm: RealmId,
  accountId: number,
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.transaction(async (tx) => {
    await tx
      .delete(accountMfaRecoveryCodesTable)
      .where(
        and(
          eq(accountMfaRecoveryCodesTable.realm, realm),
          eq(accountMfaRecoveryCodesTable.account_id, accountId),
        ),
      );
    await tx
      .insert(accountMfaRecoveryCodesTable)
      .values(codes.map((c) => ({ realm, account_id: accountId, code_hash: hashRecovery(c) })));
  });
  return codes;
}

async function countRecoveryCodes(realm: RealmId, accountId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountMfaRecoveryCodesTable)
    .where(
      and(
        eq(accountMfaRecoveryCodesTable.realm, realm),
        eq(accountMfaRecoveryCodesTable.account_id, accountId),
        isNull(accountMfaRecoveryCodesTable.used_at),
      ),
    );
  return rows[0]?.n ?? 0;
}

async function registerFailure(row: AccountMfaRow): Promise<never> {
  const failures = row.failed_attempts + 1;
  const lock = failures >= MAX_FAILURES;
  await db
    .update(accountMfaTable)
    .set({
      failed_attempts: lock ? 0 : failures,
      locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : row.locked_until,
    })
    .where(
      and(eq(accountMfaTable.realm, row.realm), eq(accountMfaTable.account_id, row.account_id)),
    );
  throw new UnauthorizedError('Invalid code', 'mfa_code_invalid');
}

/**
 * Accepts an authenticator code **or** an unused recovery code.
 * Returns which one was used so the caller can tell the person their codes are running low.
 */
export async function verifySecondFactor(
  realm: RealmId,
  accountId: number,
  code: string,
): Promise<'totp' | 'recovery'> {
  const row = await findRow(realm, accountId);
  if (!row?.confirmed_at) throw new UnauthorizedError('Invalid code', 'mfa_code_invalid');
  if (row.locked_until && row.locked_until > new Date()) {
    throw new BusinessError(429, 'Too many attempts. Try again later.', 'mfa_locked');
  }
  const trimmed = code.trim();

  const step = matchStep(open(row.secret_sealed), trimmed, new Date());
  if (step !== null) {
    if (row.last_used_step !== null && step <= row.last_used_step) {
      // Same code twice — the replay a shoulder-surfer would try.
      return registerFailure(row);
    }
    await db
      .update(accountMfaTable)
      .set({ last_used_step: step, failed_attempts: 0, locked_until: null })
      .where(and(eq(accountMfaTable.realm, realm), eq(accountMfaTable.account_id, accountId)));
    return 'totp';
  }

  if (/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(trimmed)) {
    const used = await db
      .update(accountMfaRecoveryCodesTable)
      .set({ used_at: new Date() })
      .where(
        and(
          eq(accountMfaRecoveryCodesTable.realm, realm),
          eq(accountMfaRecoveryCodesTable.account_id, accountId),
          eq(accountMfaRecoveryCodesTable.code_hash, hashRecovery(trimmed)),
          isNull(accountMfaRecoveryCodesTable.used_at),
        ),
      )
      .returning({ id: accountMfaRecoveryCodesTable.id });
    if (used.length > 0) {
      await db
        .update(accountMfaTable)
        .set({ failed_attempts: 0, locked_until: null })
        .where(and(eq(accountMfaTable.realm, realm), eq(accountMfaTable.account_id, accountId)));
      return 'recovery';
    }
  }
  return registerFailure(row);
}

/** Removes the factor entirely. Callers decide who may (self when optional · admin reset). */
export async function clear(realm: RealmId, accountId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(accountMfaRecoveryCodesTable)
      .where(
        and(
          eq(accountMfaRecoveryCodesTable.realm, realm),
          eq(accountMfaRecoveryCodesTable.account_id, accountId),
        ),
      );
    await tx
      .delete(accountMfaTable)
      .where(and(eq(accountMfaTable.realm, realm), eq(accountMfaTable.account_id, accountId)));
  });
}
