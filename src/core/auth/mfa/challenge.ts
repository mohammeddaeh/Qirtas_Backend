import { createHmac, timingSafeEqual } from 'node:crypto';
import { signingKey } from './secret-box.js';
import type { RealmId } from '../realm.js';

/**
 * The receipt a correct password earns while the second factor is still owed.
 *
 * Stateless (HMAC-signed, 5 minutes) so no half-open "pending session" row
 * exists to leak, sweep or confuse with a real session. It grants **nothing**
 * by itself — only the right to submit a code for this one account.
 */

const TTL_MS = 5 * 60 * 1000;

interface Payload {
  r: RealmId;
  a: number;
  e: number;
}

function sign(body: string): string {
  return createHmac('sha256', signingKey()).update(body).digest('base64url');
}

export function issueChallenge(realm: RealmId, accountId: number, now = new Date()): string {
  const body = Buffer.from(
    JSON.stringify({ r: realm, a: accountId, e: now.getTime() + TTL_MS } satisfies Payload),
  ).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function readChallenge(
  token: string,
  now = new Date(),
): { realm: RealmId; accountId: number } | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as Payload;
    if (typeof p.a !== 'number' || p.e < now.getTime()) return null;
    return { realm: p.r, accountId: p.a };
  } catch {
    return null;
  }
}
