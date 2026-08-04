import { RateLimitError } from '../http/api-error.js';

interface Attempt {
  count: number;
  windowStartedAt: number;
}

/**
 * In-memory fixed-window rate limiter — sufficient for a single-process
 * deployment (see docs/architecture.md; revisit with a shared store like
 * Redis if this backend ever scales to multiple instances). State resets on
 * process restart, which is acceptable for a login brute-force guard.
 */
export class RateLimiter {
  private readonly attempts = new Map<string, Attempt>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    /**
     * Shown when the limit trips. Configurable because this class now guards
     * more than login — "too many login attempts" is wrong and confusing on a
     * registration flood, and the message reaches an actual person.
     */
    private readonly message = 'Too many login attempts — please try again later',
    /** Translation key for [message] — see core/i18n/messages.ts. */
    private readonly messageKey?: string,
  ) {}

  /** Throws RateLimitError if `key` has exceeded maxAttempts within the current window; otherwise records this attempt. */
  consume(key: string): void {
    const now = Date.now();
    const existing = this.attempts.get(key);

    if (!existing || now - existing.windowStartedAt >= this.windowMs) {
      this.attempts.set(key, { count: 1, windowStartedAt: now });
      return;
    }

    if (existing.count >= this.maxAttempts) {
      const retryAfterSeconds = Math.ceil((existing.windowStartedAt + this.windowMs - now) / 1000);
      throw new RateLimitError(retryAfterSeconds, this.message, this.messageKey);
    }

    existing.count += 1;
  }

  /** Clears the counter for `key` — called on a successful login so a legitimate user isn't penalized by their own prior failures. */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  /** Drops windows that expired at least one full window ago — prevents unbounded map growth from one-off/scanning callers. */
  sweepExpired(): void {
    const now = Date.now();
    for (const [key, attempt] of this.attempts) {
      if (now - attempt.windowStartedAt >= this.windowMs * 2) {
        this.attempts.delete(key);
      }
    }
  }
}
