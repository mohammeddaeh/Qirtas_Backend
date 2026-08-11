import { authConfig } from '../config/auth-config.js';
import { generateCode, hashToken, tokenHashEquals } from './token.service.js';
import * as tokensRepository from '../repositories/verification-tokens.repository.js';
import type { VerificationPurpose } from '../schemas/verification-tokens.schema.js';

/**
 * Issuing and spending the short codes that prove control of an email address.
 *
 * Shared by email verification and password reset — the machinery is identical
 * (issue, hash, expire, count attempts, consume once) and only the effect of
 * succeeding differs, which is the caller's business.
 *
 * ## The four bounds that make a 40-bit code safe
 *
 * A code short enough to read off a screen and type is, on its own, trivially
 * guessable by a machine. What makes it safe is that a machine never gets to
 * try:
 *
 * 1. **Lifetime** — fifteen minutes by default.
 * 2. **Attempts per code** — a hard ceiling bound to the code itself, so it
 *    survives IP rotation. This is the bound the previous design lacked
 *    entirely: reset codes were defended only by a per-IP rate limiter, which
 *    an attacker with a pool of addresses never fills.
 * 3. **Single use** — enforced by a conditional `UPDATE`, not by a read-then-
 *    write, so two simultaneous requests cannot both spend the same code.
 * 4. **One live code per purpose** — issuing invalidates its predecessors, so
 *    "request many codes then guess against all of them" is not a strategy.
 *
 * Together these cap the total guesses against an account to (attempts × codes
 * per hour), which the resend cooldown also bounds.
 */

const MINUTE_MS = 60 * 1000;

export interface IssuedCode {
  /** The plaintext, for the email. Never stored, never logged, never returned by any endpoint. */
  code: string;
  expiresAt: Date;
}

/**
 * True when [userId] asked for a code of this purpose too recently.
 *
 * Separate from issuing so the caller can decide what a refusal means. The
 * password-reset flow, which must answer identically for every address, treats
 * a cooldown hit as "silently do nothing"; the resend endpoint, which is
 * authenticated and therefore leaks nothing, reports it honestly with the
 * remaining wait.
 */
export async function secondsUntilResendAllowed(
  userId: number,
  purpose: VerificationPurpose,
): Promise<number> {
  const cooldown =
    purpose === 'email_verify'
      ? authConfig.verification.resendCooldownSeconds
      : authConfig.passwordReset.resendCooldownSeconds;

  const latest = await tokensRepository.findLatest(userId, purpose);
  if (!latest) return 0;

  const elapsedSeconds = (Date.now() - latest.created_at.getTime()) / 1000;
  const remaining = Math.ceil(cooldown - elapsedSeconds);
  return remaining > 0 ? remaining : 0;
}

/**
 * Mints a code, invalidating any still outstanding for the same purpose.
 *
 * The invalidation is the point, not tidiness: with several live codes at once,
 * an attacker requesting a hundred resends would face a hundred independent
 * attempt budgets against the same account.
 */
export async function issueCode(
  userId: number,
  purpose: VerificationPurpose,
): Promise<IssuedCode> {
  const now = new Date();
  await tokensRepository.consumeAllPending(userId, purpose, now);

  const ttlMinutes =
    purpose === 'email_verify'
      ? authConfig.verification.ttlMinutes
      : authConfig.passwordReset.ttlMinutes;

  const code = generateCode();
  const expiresAt = new Date(now.getTime() + ttlMinutes * MINUTE_MS);

  await tokensRepository.insert({
    user_id: userId,
    purpose,
    token_hash: hashToken(code),
    expires_at: expiresAt,
  });

  return { code, expiresAt };
}

/**
 * Why a code was not accepted.
 *
 * The caller collapses all of these into one client-facing message on purpose —
 * telling them apart would let someone probe which accounts have a flow in
 * progress, and every one of them means the same thing to a legitimate user:
 * ask for a new code. The distinction exists for the security log, which is
 * where "wrong code" and "exhausted attempts" are genuinely different events.
 */
export type VerificationFailure = 'no_pending' | 'expired' | 'mismatch' | 'attempts_exhausted';

export type VerificationOutcome =
  | { ok: true }
  | { ok: false; reason: VerificationFailure; attemptsRemaining?: number };

/**
 * Spends [code] against [userId]'s outstanding token for [purpose].
 *
 * On success the token is consumed in the same operation that reports success,
 * so the caller can safely apply the effect afterwards knowing no second caller
 * was told the same thing.
 *
 * On a wrong guess the attempt is counted, and reaching the ceiling burns the
 * code outright. Burning the *code* rather than locking the *account* is
 * deliberate: locking would let anyone deny service to any user by guessing
 * badly on their behalf, turning a defence into an attack.
 */
export async function verifyCode(
  userId: number,
  purpose: VerificationPurpose,
  code: string,
): Promise<VerificationOutcome> {
  const pending = await tokensRepository.findPending(userId, purpose);
  // Covers both "never issued" and "already expired" — `findPending` filters
  // expiry out, so an expired code is indistinguishable from none, which is
  // also how the caller must present it.
  if (!pending) return { ok: false, reason: 'no_pending' };

  const maxAttempts =
    purpose === 'email_verify'
      ? authConfig.verification.maxAttempts
      : authConfig.passwordReset.maxAttempts;

  if (pending.attempts >= maxAttempts) {
    await tokensRepository.consumeAllPending(userId, purpose, new Date());
    return { ok: false, reason: 'attempts_exhausted' };
  }

  // Normalised before hashing because the code is typed by a person: the
  // alphabet is upper-case only, and a lower-case entry is the right code
  // entered correctly. Whitespace comes from copy-paste out of a mail client.
  const normalized = code.trim().toUpperCase();

  if (!tokenHashEquals(pending.token_hash, hashToken(normalized))) {
    const attempts = await tokensRepository.incrementAttempts(pending.id);
    if (attempts >= maxAttempts) {
      await tokensRepository.consumeAllPending(userId, purpose, new Date());
      return { ok: false, reason: 'attempts_exhausted', attemptsRemaining: 0 };
    }
    return { ok: false, reason: 'mismatch', attemptsRemaining: maxAttempts - attempts };
  }

  const consumed = await tokensRepository.consumeIfPending(pending.id, new Date());
  // Lost the race against a simultaneous request carrying the same valid code.
  // Reported as a failure rather than a success: exactly one caller may be told
  // it spent this code, and it was the other one.
  if (!consumed) return { ok: false, reason: 'no_pending' };

  return { ok: true };
}

/** Invalidates any outstanding code for [purpose] — used when the flow it belonged to is settled another way (e.g. the user changes their password while a reset is in flight). */
export async function invalidatePending(
  userId: number,
  purpose: VerificationPurpose,
): Promise<void> {
  await tokensRepository.consumeAllPending(userId, purpose, new Date());
}
