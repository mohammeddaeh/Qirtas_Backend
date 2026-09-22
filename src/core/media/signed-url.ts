import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived links to **private** files.
 *
 * The server checks who may see a file (the customer who uploaded it, the
 * production staff of the branch fulfilling the order), then hands back a link
 * that works for a few minutes and for that one file. The link itself carries
 * no identity: it is a capability, which is what lets an `<img>` tag or a
 * download manager fetch it without the Bearer token.
 *
 * Signature = HMAC-SHA256(key, "<zone>:<objectKey>:<expiresAt>"). Changing any
 * part — another file, a later expiry — invalidates it.
 */

export const DEFAULT_SIGNED_URL_TTL_SECONDS = 10 * 60;

export interface SignedLink {
  expires: number;
  signature: string;
}

export class UrlSigner {
  private readonly secret: Buffer;

  /** `secret` unset = a random per-process key (development only; env.ts refuses it in production). */
  constructor(secret?: string) {
    this.secret = secret ? Buffer.from(secret, 'utf8') : randomBytes(32);
  }

  sign(
    zone: string,
    key: string,
    ttlSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS,
    now: Date = new Date(),
  ): SignedLink {
    const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
    return { expires, signature: this.mac(zone, key, expires) };
  }

  verify(
    zone: string,
    key: string,
    expires: number,
    signature: string,
    now: Date = new Date(),
  ): boolean {
    if (!Number.isInteger(expires) || expires < Math.floor(now.getTime() / 1000)) return false;
    const expected = Buffer.from(this.mac(zone, key, expires), 'hex');
    const given = Buffer.from(signature, 'hex');
    // Length check first: timingSafeEqual throws on unequal lengths, and a
    // malformed signature is an ordinary refusal, not a 500.
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private mac(zone: string, key: string, expires: number): string {
    return createHmac('sha256', this.secret).update(`${zone}:${key}:${expires}`).digest('hex');
  }
}
