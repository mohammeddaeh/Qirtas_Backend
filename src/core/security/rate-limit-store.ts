/**
 * Where rate-limit counters live.
 *
 * Two methods, because that is all a fixed-window counter needs — and keeping
 * it at two is what makes a third implementation (Redis, Memcached, a
 * different table) a single file rather than a refactor.
 *
 * ## Why this interface exists at all
 *
 * The limiter was a `Map` in process memory, documented as "sufficient for a
 * single-process deployment". That is true and it is also invisible: a template
 * is cloned by someone who deploys two replicas behind a load balancer, and
 * the limit of five attempts silently becomes ten — with no error, no log line,
 * and identical behaviour on the single-instance machine where it was tested.
 * The only party who ever observes the difference is the one guessing
 * passwords.
 *
 * So the memory store stays the default (it is right for most deployments and
 * costs nothing), and the decision becomes one environment variable instead of
 * an unstated assumption.
 */
export interface RateLimitStore {
  /**
   * Records one attempt against `key` and reports the state of its window.
   *
   * The **store** owns the window arithmetic, not the caller: a shared store
   * must do the read and the increment as one atomic operation, and a caller
   * that read first and wrote second would let two concurrent requests both
   * see "4 attempts" and both proceed. See the Postgres implementation for how
   * that atomicity is expressed there.
   *
   * @returns `count` — attempts in the current window, including this one.
   *          `windowStartedAt` — epoch ms the window opened.
   */
  hit(key: string, windowMs: number): Promise<{ count: number; windowStartedAt: number }>;

  /** Clears the counter. Called after a successful sign-in, so a user is never punished by their own earlier typos. */
  reset(key: string): Promise<void>;

  /**
   * Drops windows that expired at least one full window ago.
   *
   * Called on a timer, not per request. Keys are attacker-chosen (an email
   * address), so without this a scanner walking addresses grows the store
   * without bound — a slow leak that only appears under the exact traffic the
   * limiter exists for.
   */
  sweepExpired(windowMs: number): Promise<void>;
}
