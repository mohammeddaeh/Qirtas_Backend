import type { NextFunction, Request, Response } from 'express';
import { RateLimiter } from '../security/rate-limiter.js';

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Guards the email-verification endpoints.
 *
 * ## Why it exists when the code already has a per-code attempt cap
 *
 * The per-code cap is the real defence and it is not replaced by this: it binds
 * the limit to the code itself, so it survives an attacker rotating IP
 * addresses. What it cannot bound is *volume* — a caller can burn a code, ask
 * for another, burn that one, and repeat. The resend cooldown slows that per
 * account; this bounds it per source, which is the shape a scripted attempt
 * against many accounts takes.
 *
 * Keyed by IP because these endpoints are authenticated, and an account key
 * would be redundant with the per-account cooldown already enforced in
 * `verification.service.ts`.
 *
 * The limit is looser than login's (10/hour, not 5/15min) because a legitimate
 * user genuinely retries here: they mistype a code read off a phone screen,
 * they ask for a resend when mail is slow. Being locked out of confirming your
 * own address is a worse outcome than the marginal attempt this allows.
 *
 * ⚠️ Same two caveats as the other limiters: in-memory (resets on restart, and
 * counts per-instance behind more than one process), and `req.ip` needs
 * Express's `trust proxy` configured if a reverse proxy is ever put in front —
 * otherwise every request resolves to the proxy and this collapses into one
 * shared bucket.
 */
const ipLimiter = new RateLimiter(
  MAX_ATTEMPTS,
  WINDOW_MS,
  'Too many verification attempts — please try again later',
  'too_many_verification_attempts',
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
export async function verificationRateLimit(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await ipLimiter.consume(`verification-ip:${req.ip ?? 'unknown'}`);
    next();
  } catch (err) {
    next(err);
  }
}
