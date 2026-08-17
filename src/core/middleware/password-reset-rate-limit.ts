import type { NextFunction, Request, Response } from 'express';
import { RateLimiter } from '../security/rate-limiter.js';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Guards the two unauthenticated password-reset endpoints.
 *
 * ## Why both endpoints need it, for different reasons
 *
 * `POST /users/forgot-password` sends mail to an address the caller chose. With
 * no limit, that is a free mail cannon pointed at anyone: repeat the request and
 * the victim's inbox fills with codes they did not ask for. The account is never
 * compromised and the person is still harassed, which is enough.
 *
 * `POST /users/reset-password` is the one that protects the account. The code is
 * six digits, so guessing is hopeless at human speed and trivial at machine
 * speed — the limit is what keeps the difference. It is
 * also why the code expires in fifteen minutes: the two together bound the
 * attempts per code to single digits.
 *
 * ## Keyed by IP, and why that is not enough on its own
 *
 * Email is the wrong key for the flood case (an attacker targeting one victim
 * sends the same address every time, but an attacker probing many addresses
 * sends a fresh one each time and never fills an email bucket). IP catches both
 * shapes at the cost of sharing a bucket between users behind one NAT.
 *
 * ⚠️ Same two caveats as the other limiters: in-memory (resets on restart, and
 * degrades to per-instance counting behind more than one process), and `req.ip`
 * needs Express's `trust proxy` configured if a reverse proxy is ever put in
 * front — otherwise every request resolves to the proxy and this collapses into
 * a single shared bucket.
 */
const ipLimiter = new RateLimiter(
  MAX_ATTEMPTS,
  WINDOW_MS,
  'Too many password reset attempts — please try again later',
  'too_many_reset_attempts',
);

// `void` because the sweep is fire-and-forget maintenance: a failed delete is
// retried by the next tick, and awaiting it here would have nowhere to report.
setInterval(() => void ipLimiter.sweepExpired(), SWEEP_INTERVAL_MS).unref();

/**
 * Async since the store may be shared (`RATE_LIMIT_STORE=postgres`).
 *
 * **The `await` is the guard.** Express 4 does not await middleware, so
 * dropping it would let this call `next()` immediately and pass the request
 * through while the `RateLimitError` surfaced separately as an unhandled
 * rejection — the guard would appear to exist and stop nothing.
 */
export async function passwordResetRateLimit(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await ipLimiter.consume(`password-reset-ip:${req.ip ?? 'unknown'}`);
    next();
  } catch (err) {
    next(err);
  }
}
