import type { RateLimitStore } from './rate-limit-store.js';

/**
 * Counters in this process's memory. **The default, and correct for a single
 * instance.**
 *
 * ## What it does not survive
 *
 * - **A second replica.** Each process keeps its own `Map`, and a load balancer
 *   spreads attempts across them, so a limit of 5 becomes 5×N. The attacker
 *   needs to know nothing about your topology — they just keep trying.
 * - **A restart.** Every deploy, crash and container recycle clears every
 *   counter.
 *
 * Neither shows up as an error, in a log, or in any test that runs on one
 * machine. Set `RATE_LIMIT_STORE=postgres` when you deploy more than one
 * instance.
 *
 * Async by interface, synchronous in fact — `Promise.resolve` costs a
 * microtask and buys one shape for both stores, so the middleware does not
 * branch on which is configured.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly attempts = new Map<string, { count: number; windowStartedAt: number }>();

  async hit(key: string, windowMs: number): Promise<{ count: number; windowStartedAt: number }> {
    const now = Date.now();
    const existing = this.attempts.get(key);

    if (!existing || now - existing.windowStartedAt >= windowMs) {
      const fresh = { count: 1, windowStartedAt: now };
      this.attempts.set(key, fresh);
      return fresh;
    }

    existing.count += 1;
    return existing;
  }

  async reset(key: string): Promise<void> {
    this.attempts.delete(key);
  }

  async sweepExpired(windowMs: number): Promise<void> {
    const now = Date.now();
    for (const [key, attempt] of this.attempts) {
      // Two windows, not one: a key whose window just closed is about to be
      // written again by the next attempt, and deleting it early costs a
      // re-allocation for nothing.
      if (now - attempt.windowStartedAt >= windowMs * 2) {
        this.attempts.delete(key);
      }
    }
  }
}
