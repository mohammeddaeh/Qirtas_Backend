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
 * or are 6–8 characters that live fifteen minutes and are attempt-capped
 * (codes). A per-row salt would also make lookup impossible without first
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
 * Unambiguous alphabet: no `O`/`0`, no `I`/`1`.
 *
 * These codes are read off one screen and typed into another by a person who
 * cannot ask what a glyph was meant to be. Removing the four confusable
 * characters costs a fraction of a bit of entropy and removes an entire class
 * of "the code doesn't work" reports.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A short code for email delivery.
 *
 * Entropy is deliberately modest — 8 characters from a 32-symbol alphabet is
 * 40 bits, which is trivial for a machine and impossible for a human. What
 * makes it safe is not its size but its bounds: a fifteen-minute life and a
 * hard per-code attempt ceiling (see verification.service.ts). Lengthening the
 * code without those two would change nothing; keeping those two lets the code
 * stay short enough to type.
 *
 * `randomBytes` is rejection-free here because 256 is an exact multiple of 32,
 * so the modulo introduces no bias.
 */
export function generateCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}
