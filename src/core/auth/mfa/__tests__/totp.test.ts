import { describe, expect, it } from 'vitest';
import { base32Encode, codeAt, matchStep, otpauthUri, stepAt } from '../totp.js';
import { issueChallenge, readChallenge } from '../challenge.js';
import { open, seal } from '../secret-box.js';

// RFC 6238 Appendix B — SHA1 secret "12345678901234567890"; the 8-digit
// reference values truncate to these 6-digit ones.
const RFC_SECRET = Buffer.from('12345678901234567890');

describe('totp', () => {
  it('matches the RFC 6238 vectors', () => {
    expect(codeAt(RFC_SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(codeAt(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(codeAt(RFC_SECRET, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepts the current, previous and next step — and nothing further', () => {
    const now = new Date(1111111109 * 1000);
    const step = stepAt(now);
    expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step), now)).toBe(step);
    expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step + 2), now)).toBeNull();
    expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step - 2), now)).toBeNull();
  });

  it('rejects malformed codes without throwing', () => {
    const now = new Date();
    expect(matchStep(RFC_SECRET, '12345', now)).toBeNull();
    expect(matchStep(RFC_SECRET, 'abcdef', now)).toBeNull();
    expect(matchStep(RFC_SECRET, '', now)).toBeNull();
  });

  it('encodes base32 per RFC 4648 and builds an importable URI', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    const uri = otpauthUri({ secret: RFC_SECRET, account: 'a@b.com', issuer: 'Qirtas' });
    expect(uri).toContain('otpauth://totp/Qirtas%3Aa%40b.com');
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('challenge', () => {
  it('round-trips and expires', () => {
    const t = issueChallenge('staff', 7, new Date(0));
    expect(readChallenge(t, new Date(60_000))).toEqual({ realm: 'staff', accountId: 7 });
    expect(readChallenge(t, new Date(6 * 60_000))).toBeNull();
  });

  it('refuses a tampered payload (account swapped, signature kept)', () => {
    const t = issueChallenge('staff', 7, new Date(0));
    const [, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ r: 'staff', a: 1, e: 9e15 })).toString('base64url');
    expect(readChallenge(`${forged}.${mac}`, new Date(0))).toBeNull();
    expect(readChallenge('x', new Date(0))).toBeNull();
  });
});

describe('secret box', () => {
  it('opens what it sealed, and refuses a corrupted value', () => {
    const sealed = seal(RFC_SECRET);
    expect(open(sealed).equals(RFC_SECRET)).toBe(true);
    expect(sealed).not.toContain(RFC_SECRET.toString('base64'));
    const parts = sealed.split('.');
    parts[2] = Buffer.from('tampered-body-bytes').toString('base64');
    expect(() => open(parts.join('.'))).toThrow();
  });
});
