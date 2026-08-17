import { RateLimitError } from '../http/api-error.js';
import { env } from '../config/env.js';
import type { RateLimitStore } from './rate-limit-store.js';
import { MemoryRateLimitStore } from './memory-rate-limit-store.js';
import { PostgresRateLimitStore } from './postgres-rate-limit-store.js';

/**
 * The store every limiter shares, chosen once from `RATE_LIMIT_STORE`.
 *
 * One instance rather than one per limiter: the Postgres store holds no state
 * of its own, and the memory store's keys are already namespaced by their
 * callers (`email:` / `ip:`), so separate maps would only fragment the sweep.
 */
const sharedStore: RateLimitStore =
  env.RATE_LIMIT_STORE === 'postgres'
    ? new PostgresRateLimitStore()
    : new MemoryRateLimitStore();

/**
 * Fixed-window rate limiter.
 *
 * ## Where the counters live
 *
 * In `RATE_LIMIT_STORE` — `memory` by default, `postgres` for deployments
 * running more than one instance. This class used to own a `Map` directly, and
 * carried a comment saying that was "sufficient for a single-process
 * deployment". True, and invisible: a second replica silently doubles every
 * limit, with no error and no log line, and the only party who observes the
 * difference is the one guessing passwords. See `rate-limit-store.ts`.
 *
 * ## Why the methods are async
 *
 * A shared store is a network call. The middleware wrappers in
 * `core/middleware/*-rate-limit.ts` are `asyncHandler`-wrapped for this reason
 * — a thrown `RateLimitError` still reaches `errorHandler` the same way.
 */
export class RateLimiter {
  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    /**
     * Shown when the limit trips. Configurable because this class guards more
     * than login — "too many login attempts" is wrong and confusing on a
     * registration flood, and the message reaches an actual person.
     */
    private readonly message = 'Too many login attempts — please try again later',
    /** Translation key for [message] — see core/i18n/messages.ts. */
    private readonly messageKey?: string,
    /** Overridable for tests, which need a store they can inspect and reset. */
    private readonly store: RateLimitStore = sharedStore,
  ) {}

  /** Records this attempt; throws `RateLimitError` if `key` has exceeded maxAttempts within the current window. */
  async consume(key: string): Promise<void> {
    const { count, windowStartedAt } = await this.store.hit(key, this.windowMs);

    if (count <= this.maxAttempts) return;

    // Seconds, never milliseconds: `Retry-After` is defined in seconds, and a
    // millisecond value tells a client to wait eleven days while looking like
    // a working header.
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowStartedAt + this.windowMs - Date.now()) / 1000),
    );
    throw new RateLimitError(retryAfterSeconds, this.message, this.messageKey);
  }

  /** Clears the counter for `key` — called on a successful login so a legitimate user isn't penalized by their own prior failures. */
  async reset(key: string): Promise<void> {
    await this.store.reset(key);
  }

  /** Drops windows that expired at least one full window ago — prevents unbounded growth from one-off/scanning callers. */
  async sweepExpired(): Promise<void> {
    await this.store.sweepExpired(this.windowMs);
  }
}
