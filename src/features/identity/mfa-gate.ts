import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '../../core/http/api-error.js';
import * as mfaService from '../../core/auth/mfa/mfa.service.js';
import { mfaEnforced } from './mfa-policy.js';

/**
 * What a required-but-not-enrolled account may still call: enough to enroll,
 * see who it is, and leave. Everything else answers 403 `mfa_setup_required`.
 */
const ALLOWED = [
  /^\/api\/v1\/auth\/mfa(\/|$)/,
  /^\/api\/v1\/users\/me$/,
  /^\/api\/v1\/users\/logout$/,
  /^\/api\/v1\/auth\/refresh$/,
];

/**
 * The teeth of "mandatory".
 *
 * The `auth` middleware never rejects (by design — routes declare their own
 * protection), so the requirement cannot live there. It is a separate gate,
 * mounted once right after it, that turns an un-enrolled required account into a
 * setup-only session. Being global means no route can forget it.
 *
 * Cost: one primary-key lookup per staff request; the role query runs only for
 * accounts that have NOT enrolled.
 */
export async function mfaEnrollmentGate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user || !mfaEnforced()) return next();
  if (ALLOWED.some((re) => re.test(req.originalUrl.split('?')[0] ?? ''))) return next();
  if (await mfaService.isEnrolled('staff', req.user.id)) return next();
  if (!(await mfaService.isRequired('staff', req.user.id))) return next();
  throw new ForbiddenError(
    'Set up two-factor authentication to continue',
    { mfa_setup_required: true },
    'mfa_setup_required',
  );
}
