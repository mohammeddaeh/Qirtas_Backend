import type { NextFunction, Request, Response } from 'express';
import { RateLimiter } from '../security/rate-limiter.js';
import { readChallenge } from '../auth/mfa/challenge.js';

const MAX_ATTEMPTS_PER_EMAIL = 5;
/**
 * Deliberately far above the per-email budget, not equal to it.
 *
 * One IP is one *network*, not one person: a branch behind a single router,
 * an office NAT, a carrier CGNAT. At parity (both 5) this bucket stops being
 * the secondary layer it is documented as and becomes the binding one — five
 * failed logins *in total*, spread across five different employees, lock the
 * whole site out for fifteen minutes, and nothing on any of their screens can
 * explain why a correct password is being refused. It also makes the number
 * unusable in development, where one device cycles through many test accounts.
 *
 * The primary defence against guessing a specific account is the per-email
 * bucket, and it is untouched by this: an attacker with a thousand IPs still
 * gets five tries per account. What this bucket buys is the other direction —
 * one source spraying one password across many accounts — and 30/15min still
 * cuts that to a crawl while staying above anything a real shared network
 * produces by accident.
 */
const MAX_ATTEMPTS_PER_IP = 30;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Two independent limiters, both must pass:
 * - per-email: stops credential stuffing / brute force against one account
 *   from many source IPs — this is the real security boundary and holds
 *   regardless of IP rotation.
 * - per-IP: stops one source hammering many different accounts.
 * Mount after validate(loginBodySchema) — needs req.body.email normalized.
 *
 * ⚠️ req.ip depends on Express's `trust proxy` setting (unset/false today —
 * correct for a direct-connection deployment with no reverse proxy in front,
 * see app.ts). If this backend is ever placed behind a reverse proxy/load
 * balancer, `trust proxy` MUST be configured then, or every request will
 * resolve to the proxy's own IP and the per-IP limiter will collapse into a
 * single shared bucket for all clients. The per-email limiter is unaffected
 * either way — this only weakens the secondary layer, not the primary one.
 */
const LOGIN_MESSAGE = 'Too many login attempts — please try again later';
const emailLimiter = new RateLimiter(
  MAX_ATTEMPTS_PER_EMAIL,
  WINDOW_MS,
  LOGIN_MESSAGE,
  'too_many_login_attempts',
);
const ipLimiter = new RateLimiter(
  MAX_ATTEMPTS_PER_IP,
  WINDOW_MS,
  LOGIN_MESSAGE,
  'too_many_login_attempts',
);

// `void` because the sweep is fire-and-forget maintenance: a failed delete is
// retried by the next tick, and awaiting it here would have nowhere to report.
setInterval(() => {
  void emailLimiter.sweepExpired();
  void ipLimiter.sweepExpired();
}, SWEEP_INTERVAL_MS).unref();

/**
 * Async since the store may be shared (`RATE_LIMIT_STORE=postgres`).
 *
 * **The `await`s are the guard.** Express 4 does not await middleware, so
 * dropping them would let this call `next()` immediately and pass the request
 * through while the `RateLimitError` surfaced separately as an unhandled
 * rejection — the guard would appear to exist and stop nothing. The try/catch
 * around them is what keeps the rejection on the `next(err)` path.
 *
 * Email first, then IP: the per-email limit is the real boundary, so a
 * credential-stuffing run is refused on the identifier that actually bounds it.
 */
export async function loginRateLimit(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const email = (req.body as { email?: string }).email ?? 'unknown';
    const ip = req.ip ?? 'unknown';
    await emailLimiter.consume(`email:${email}`);
    await ipLimiter.consume(`ip:${ip}`);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Called by the login controller on a successful login — clears both counters
 * for this attempt's identifiers.
 *
 * Fire-and-forget: the sign-in has already succeeded, and making the caller
 * await a counter reset would delay the response to add nothing. A failed reset
 * costs the user their next few attempts at worst, and the window expires
 * regardless.
 */
export function resetLoginRateLimit(email: string, ip: string): void {
  void emailLimiter.reset(`email:${email}`);
  void ipLimiter.reset(`ip:${ip}`);
}

const mfaAccountLimiter = new RateLimiter(
  30,
  WINDOW_MS,
  LOGIN_MESSAGE,
  'too_many_login_attempts',
);

/**
 * Brake for the second step of sign-in (`POST /users/login/mfa`).
 *
 * **Not `loginRateLimit`**: that keys on the request's `email`, which this body
 * does not carry — every caller would share the single bucket `email:unknown`,
 * and five people typing a code within 15 minutes would lock every other staff
 * member out of step two. The identifier here is the account the challenge was
 * issued for (readable without trusting it: a forged token has no account and
 * falls to the IP limit alone).
 *
 * The per-account code lockout in `mfa.service` is the real defence against
 * guessing; this bounds request volume and the challenge-forging noise.
 */
export async function mfaLoginRateLimit(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = (req.body as { mfa_token?: string }).mfa_token ?? '';
    const claim = readChallenge(token);
    if (claim) await mfaAccountLimiter.consume(`mfa:${claim.realm}:${claim.accountId}`);
    await ipLimiter.consume(`ip:${req.ip ?? 'unknown'}`);
    next();
  } catch (err) {
    next(err);
  }
}
