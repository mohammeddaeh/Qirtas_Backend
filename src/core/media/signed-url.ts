import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived links to **private** files, and upload tokens for the local
 * driver.
 *
 * The server checks who may see a file (the customer who uploaded it, the
 * production staff of the branch fulfilling the order), then hands back a link
 * that works for a few minutes and for that one file. The link itself carries
 * no identity: it is a capability, which is what lets an `<img>` tag or a
 * download manager fetch it without the Bearer token.
 *
 * Signature = HMAC-SHA256(key, "<zone>:<objectKey>:<expiresAt>[:<name>]").
 * Changing any part — another file, a later expiry, another offered name —
 * invalidates it.
 *
 * ⚠️ Every server machine must share `STORAGE_SIGNING_KEY`: a link issued by
 * one machine is served by whichever machine the next request lands on.
 */

export const DEFAULT_SIGNED_URL_TTL_SECONDS = 10 * 60;

export interface SignedLink {
  expires: number;
  signature: string;
}

/** What an upload token lets its holder write — one object, one exact size, one type. */
export interface UploadGrant {
  zone: string;
  key: string;
  bytes: number;
  contentType: string;
  expires: number;
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
    name?: string,
  ): SignedLink {
    const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
    return { expires, signature: this.mac(linkPayload(zone, key, expires, name)) };
  }

  verify(
    zone: string,
    key: string,
    expires: number,
    signature: string,
    now: Date = new Date(),
    name?: string,
  ): boolean {
    if (!Number.isInteger(expires) || expires < Math.floor(now.getTime() / 1000)) return false;
    return this.matches(linkPayload(zone, key, expires, name), signature);
  }

  /**
   * `<base64url JSON>.<hex mac>` — travels in a URL path, so only URL-safe
   * characters. The payload is readable by its holder on purpose: it says
   * nothing the holder did not already send when reserving.
   */
  signUpload(
    grant: Omit<UploadGrant, 'expires'>,
    ttlSeconds: number,
    now: Date = new Date(),
  ): {
    token: string;
    expires: number;
  } {
    const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
    const body = Buffer.from(
      JSON.stringify({
        z: grant.zone,
        k: grant.key,
        n: grant.bytes,
        t: grant.contentType,
        e: expires,
      }),
      'utf8',
    ).toString('base64url');
    return { token: `${body}.${this.mac(`upload:${body}`)}`, expires };
  }

  /** `null` for anything but an intact, unexpired token — a malformed one is a refusal, not a 500. */
  verifyUpload(token: string, now: Date = new Date()): UploadGrant | null {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    if (!this.matches(`upload:${body}`, token.slice(dot + 1))) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const p = parsed as { z?: unknown; k?: unknown; n?: unknown; t?: unknown; e?: unknown };
    if (
      typeof p.z !== 'string' ||
      typeof p.k !== 'string' ||
      typeof p.t !== 'string' ||
      !Number.isInteger(p.n) ||
      !Number.isInteger(p.e)
    ) {
      return null;
    }
    if ((p.e as number) < Math.floor(now.getTime() / 1000)) return null;
    return { zone: p.z, key: p.k, bytes: p.n as number, contentType: p.t, expires: p.e as number };
  }

  private matches(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.mac(payload), 'hex');
    const given = Buffer.from(signature, 'hex');
    // Length check first: timingSafeEqual throws on unequal lengths, and a
    // malformed signature is an ordinary refusal, not a 500.
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }
}

/** The name is part of the signature, so a link cannot be re-labelled `invoice.exe`. */
function linkPayload(zone: string, key: string, expires: number, name?: string): string {
  const base = `${zone}:${key}:${expires}`;
  return name === undefined ? base : `${base}:${encodeURIComponent(name)}`;
}
