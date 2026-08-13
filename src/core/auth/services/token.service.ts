import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Generation and comparison of the opaque secrets this engine issues:
 * session tokens and the short codes that travel by email.
 *
 * Both are hashed before storage, for the same reason and with the same
 * algorithm — see the two schema files for why SHA-256 rather than a password
 * KDF is correct for high-entropy, short-lived values.
 */

/** Opaque bearer token — 256 bits of CSPRNG output, hex-encoded (64 chars). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The digest stored in `sessions.token_hash` / `auth_verification_tokens.token_hash`.
 *
 * Unsalted on purpose. A salt defends against precomputation, which requires a
 * guessable input space; these inputs are drawn uniformly from 2^256 (tokens)
 * or are six digits that live fifteen minutes and are attempt-capped (codes).
 * A per-row salt would also make lookup impossible without first
 * finding the row — turning one indexed probe on every authenticated request
 * into a scan.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Compares two hex digests without leaking their divergence point through
 * timing.
 *
 * Worth doing even though both sides are hashes: the attacker controls the
 * candidate, and `===` on strings returns as soon as it finds a differing byte.
 * That is a real (if narrow) channel for recovering a stored digest byte by
 * byte, and the cost of closing it is one function call.
 *
 * Length is checked first because `timingSafeEqual` throws on a mismatch, and a
 * thrown exception is itself an observable difference.
 */
export function tokenHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Digits only.
 *
 * The previous alphabet was 32 letters and digits with the confusable glyphs
 * removed (`O`/`0`, `I`/`1`) — unambiguous to read, but not to *type*: a mixed
 * alphabet forces a phone keyboard to switch layouts mid-code, and gives the
 * user a shift key they can get wrong. Ten digits have no confusable pair at
 * all, open the numeric keypad directly, and are what every reader already
 * expects a verification code to look like.
 */
const CODE_ALPHABET = '0123456789';

const CODE_LENGTH = 6;

/**
 * The largest multiple of the alphabet size that fits in one byte.
 *
 * 256 is not divisible by 10, so `byte % 10` alone would make the digits 0–5
 * appear more often than 6–9. Bytes at or above this bound are discarded and
 * redrawn instead — the standard fix, and cheap here (a 2.3% redraw rate).
 */
const UNBIASED_LIMIT = 256 - (256 % CODE_ALPHABET.length);

/**
 * A short code for email delivery.
 *
 * Entropy is deliberately modest — six digits is a million possibilities, which
 * is trivial for a machine and impossible for a human. What makes it safe is not
 * its size but its bounds: a fifteen-minute life, a hard per-code attempt
 * ceiling, one live code per purpose, and a resend cooldown (all four in
 * verification.service.ts). Together they cap an attacker at a few hundred
 * guesses an hour against a million-value space. Lengthening the code without
 * those bounds would change nothing; keeping them lets it stay short enough to
 * read once and type from memory.
 */
export function generateCode(length = CODE_LENGTH): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= UNBIASED_LIMIT) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}
