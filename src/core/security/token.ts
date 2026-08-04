import { randomBytes } from 'node:crypto';

/** Opaque, unguessable session token — 256 bits of entropy, hex-encoded. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}
