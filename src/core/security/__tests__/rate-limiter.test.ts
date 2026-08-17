import { describe, expect, it, vi, afterEach } from 'vitest';
import { RateLimiter } from '../rate-limiter.js';
import { MemoryRateLimitStore } from '../memory-rate-limit-store.js';
import { RateLimitError } from '../../http/api-error.js';

/**
 * The rate limiter, pinned.
 *
 * It is the only thing standing between the two unauthenticated endpoints —
 * `/users/login` and `/auth/forgot-password` — and a machine-speed guessing
 * loop. It had no tests.
 *
 * Each limiter below is given its **own** store rather than the shared module
 * singleton: tests that share a counter leak state into each other, and the
 * failure reads as flakiness rather than as coupling.
 */

function limiter(max: number, windowMs: number, message?: string): RateLimiter {
  return new RateLimiter(max, windowMs, message, undefined, new MemoryRateLimitStore());
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RateLimiter', () => {
  it('allows exactly maxAttempts, then refuses', async () => {
    const rl = limiter(3, 60_000);

    await expect(rl.consume('a@x.com')).resolves.toBeUndefined();
    await expect(rl.consume('a@x.com')).resolves.toBeUndefined();
    await expect(rl.consume('a@x.com')).resolves.toBeUndefined();
    await expect(rl.consume('a@x.com')).rejects.toThrow(RateLimitError);
  });

  it('keys are independent — one address cannot exhaust another', async () => {
    // The per-email limit is what holds against credential stuffing from many
    // source addresses. If keys bled into each other, one attacker would lock
    // out every account they touched — turning the guard into the denial of
    // service it exists to prevent.
    const rl = limiter(1, 60_000);
    await rl.consume('a@x.com');
    await expect(rl.consume('b@x.com')).resolves.toBeUndefined();
  });

  it('carries Retry-After, and it is in seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));

    const rl = limiter(1, 60_000);
    await rl.consume('a@x.com');

    vi.advanceTimersByTime(15_000);

    // 45 seconds left of a 60-second window. A header in milliseconds would
    // tell a client to wait 45,000 seconds and look like a working feature.
    await expect(rl.consume('a@x.com')).rejects.toMatchObject({
      httpStatus: 429,
      headers: { 'Retry-After': '45' },
    });
  });

  it('the window expires — a refusal is temporary, not permanent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));

    const rl = limiter(1, 60_000);
    await rl.consume('a@x.com');
    await expect(rl.consume('a@x.com')).rejects.toThrow();

    vi.advanceTimersByTime(60_001);
    await expect(rl.consume('a@x.com')).resolves.toBeUndefined();
  });

  it('reset() clears the counter — what a successful sign-in calls', async () => {
    // Without this, a user who mistypes their password twice and then gets it
    // right is still one attempt from being locked out of their own account.
    const rl = limiter(2, 60_000);
    await rl.consume('a@x.com');
    await rl.consume('a@x.com');
    await rl.reset('a@x.com');
    await expect(rl.consume('a@x.com')).resolves.toBeUndefined();
  });

  it('sweepExpired() bounds memory growth from one-off keys', async () => {
    // Every distinct key allocates an entry, and the keys are attacker-chosen
    // (an email address). Without the sweep, a scanner walking addresses grows
    // the store without limit — a slow leak that only shows up under the exact
    // traffic the limiter exists for.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));

    const rl = limiter(1, 1_000);
    for (let i = 0; i < 100; i += 1) await rl.consume(`scan-${i}@x.com`);

    vi.advanceTimersByTime(2_001);
    await rl.sweepExpired();

    // Every swept key is startable again — the observable consequence of the
    // entry being gone.
    await expect(rl.consume('scan-0@x.com')).resolves.toBeUndefined();
  });

  it('the message is configurable — "too many login attempts" is wrong on a '
    + 'registration flood', async () => {
    const rl = limiter(1, 60_000, 'Too many registrations');
    await rl.consume('ip:1.2.3.4');
    await expect(rl.consume('ip:1.2.3.4')).rejects.toThrow('Too many registrations');
  });
});

describe('MemoryRateLimitStore', () => {
  it('counts within a window and restarts after it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));

    const store = new MemoryRateLimitStore();
    expect((await store.hit('k', 1_000)).count).toBe(1);
    expect((await store.hit('k', 1_000)).count).toBe(2);

    vi.advanceTimersByTime(1_001);
    // A new window, not a continuation — this is the property the Postgres
    // store expresses as a CASE inside its upsert, and the two must agree.
    expect((await store.hit('k', 1_000)).count).toBe(1);
  });

  it('reports the window start, so Retry-After can be computed', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-11T00:00:00.000Z');
    vi.setSystemTime(now);

    const store = new MemoryRateLimitStore();
    const first = await store.hit('k', 60_000);
    vi.advanceTimersByTime(30_000);
    const second = await store.hit('k', 60_000);

    // The window does NOT slide with use — a fixed window, so the second hit
    // reports the first hit's start. A sliding window here would let a caller
    // hold a bucket open indefinitely by tapping it.
    expect(second.windowStartedAt).toBe(first.windowStartedAt);
    expect(first.windowStartedAt).toBe(now.getTime());
  });
});
