import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../logger/logger.js';

/**
 * Encryption at rest for TOTP secrets (AES-256-GCM).
 *
 * A TOTP secret is a **reusable** credential — unlike a password hash it cannot
 * be one-way, because the server must recompute the code from it. A database
 * leak with plaintext secrets therefore hands over every second factor at once,
 * so they are sealed with a key that lives in the environment, not the database.
 *
 * Also the signing key for login challenges (see `challenge.ts`).
 */

function key(): Buffer {
  const raw = env.MFA_ENCRYPTION_KEY;
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      // Refused, not defaulted: a guessable key would make the encryption a
      // decoration while every log line and test still said "encrypted".
      throw new Error('MFA_ENCRYPTION_KEY must be set in production.');
    }
    warnOnce();
    return createHash('sha256').update('qirtas-dev-only-mfa-key').digest();
  }
  return createHash('sha256').update(raw).digest();
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  logger.warn('MFA_ENCRYPTION_KEY is not set — using an insecure development key.');
}

export function seal(plain: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function open(sealed: string): Buffer {
  const [iv, tag, body] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !body) throw new Error('Malformed sealed value');
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function signingKey(): Buffer {
  return key();
}
