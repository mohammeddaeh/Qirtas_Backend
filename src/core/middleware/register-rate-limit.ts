import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { RateLimiter } from '../security/rate-limiter.js';

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Guards self-registration against flooding.
 *
 * `POST /users/register` was the one unauthenticated write in the system with
 * no limit at all (production_readiness.md §A5): anyone could open thousands of
 * `pending_approval` accounts and bury the review queue, which is an admin's
 * working tool, not just a table.
 *
 * Per-IP only, unlike the login limiter's IP+email pair. Email is the wrong key
 * here — every flood request carries a fresh address, so an email bucket would
 * never fill. The window is an hour rather than login's fifteen minutes because
 * registration is a once-in-a-career action for a real person, so a tight cap
 * costs legitimate users nothing.
 *
 * ⚠️ Same two caveats as the login limiter: in-memory (resets on restart, and
 * degrades to per-instance counting behind more than one process), and `req.ip`
 * needs Express's `trust proxy` configured if a reverse proxy is ever put in
 * front — otherwise every request resolves to the proxy and this collapses into
 * a single shared bucket.
 */
function makeLimiter(max: number): RateLimiter {
  const limiter = new RateLimiter(
    max,
    WINDOW_MS,
    'Too many registration attempts — please try again later',
    'too_many_register_attempts',
  );
  // `void` because the sweep is fire-and-forget maintenance.
  setInterval(() => void limiter.sweepExpired(), SWEEP_INTERVAL_MS).unref();
  return limiter;
}

const staffLimiter = makeLimiter(env.STAFF_REGISTER_RATE_LIMIT);
const customerLimiter = makeLimiter(env.CUSTOMER_REGISTER_RATE_LIMIT);

/**
 * Async since the store may be shared (`RATE_LIMIT_STORE=postgres`).
 *
 * **The `await` is the guard.** Express 4 does not await middleware, so
 * dropping it would let this call `next()` immediately and pass the request
 * through while the `RateLimitError` surfaced separately as an unhandled
 * rejection — the guard would appear to exist and stop nothing.
 */
function guard(limiter: RateLimiter, prefix: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await limiter.consume(`${prefix}:${req.ip ?? 'unknown'}`);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Employee self-registration — tight: each success occupies an admin's review queue. */
export const registerRateLimit = guard(staffLimiter, 'register-ip');

/** Shopper sign-up — looser, and separate: shoppers share addresses (CGNAT, offices) and must not drain the employees' bucket or the reverse. */
export const customerRegisterRateLimit = guard(customerLimiter, 'customer-register-ip');
