import type { NextFunction, Request, Response } from 'express';
import { RateLimiter } from '../security/rate-limiter.js';

const MAX_ATTEMPTS = 5;
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
  MAX_ATTEMPTS,
  WINDOW_MS,
  LOGIN_MESSAGE,
  'too_many_login_attempts',
);
const ipLimiter = new RateLimiter(
  MAX_ATTEMPTS,
  WINDOW_MS,
  LOGIN_MESSAGE,
  'too_many_login_attempts',
);

setInterval(() => {
  emailLimiter.sweepExpired();
  ipLimiter.sweepExpired();
}, SWEEP_INTERVAL_MS).unref();

export function loginRateLimit(req: Request, _res: Response, next: NextFunction): void {
  try {
    const email = (req.body as { email?: string }).email ?? 'unknown';
    const ip = req.ip ?? 'unknown';
    emailLimiter.consume(`email:${email}`);
    ipLimiter.consume(`ip:${ip}`);
    next();
  } catch (err) {
    next(err);
  }
}

/** Called by the login controller on a successful login — clears both counters for this attempt's identifiers. */
export function resetLoginRateLimit(email: string, ip: string): void {
  emailLimiter.reset(`email:${email}`);
  ipLimiter.reset(`ip:${ip}`);
}
