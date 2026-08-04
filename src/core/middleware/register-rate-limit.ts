import type { NextFunction, Request, Response } from 'express';
import { RateLimiter } from '../security/rate-limiter.js';

const MAX_ATTEMPTS = 5;
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
const ipLimiter = new RateLimiter(
  MAX_ATTEMPTS,
  WINDOW_MS,
  'Too many registration attempts — please try again later',
  'too_many_register_attempts',
);

setInterval(() => ipLimiter.sweepExpired(), SWEEP_INTERVAL_MS).unref();

export function registerRateLimit(req: Request, _res: Response, next: NextFunction): void {
  try {
    ipLimiter.consume(`register-ip:${req.ip ?? 'unknown'}`);
    next();
  } catch (err) {
    next(err);
  }
}
