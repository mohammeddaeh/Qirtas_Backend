import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 time-based one-time passwords, written here rather than imported.
 *
 * The algorithm is forty lines and every authenticator app implements exactly
 * this (HMAC-SHA1, 30-second step, 6 digits) — the defaults below are not
 * tunable on purpose, because a deviation makes the code the app shows differ
 * from the one the server expects and no error says so.
 */

export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
/** Steps accepted either side of "now" — absorbs a phone clock a few seconds off. */
const WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(): Buffer {
  // 20 bytes = 160 bits, the size RFC 4226 recommends for HMAC-SHA1.
  return randomBytes(20);
}

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

export function codeAt(secret: Buffer, step: number): string {
  return hotp(secret, step);
}

/**
 * The matching time step, or `null` when the code fits none in the window.
 *
 * Returns the step (not a boolean) so the caller can refuse a **second use of
 * the same step**: a code shoulder-surfed in the 30 seconds after it was typed
 * would otherwise open a session of its own.
 */
export function matchStep(secret: Buffer, code: string, now: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  const given = Buffer.from(code);
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const expected = Buffer.from(hotp(secret, current + delta));
    if (timingSafeEqual(expected, given)) return current + delta;
  }
  return null;
}

/** The `otpauth://` URI authenticator apps import (as a QR code or a tap). */
export function otpauthUri(params: { secret: Buffer; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
