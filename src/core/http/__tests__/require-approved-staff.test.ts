import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { ApiError } from '../api-error.js';
import { requireApprovedStaff } from '../require-actor.js';

/**
 * Failing open looks like nothing: an applicant reads the branch list or the
 * permission catalogue and every request is a 200. So the refusals sit beside
 * the one case that must pass — a guard that refuses everyone would satisfy
 * the refusals alone and take the branch list away from every employee.
 */

function req(user: Request['user'], customer: Request['customer'] = null): Request {
  return { user, customer } as Request;
}

function statusOf(r: Request): number | 'passed' {
  try {
    requireApprovedStaff(r, {} as never, () => {});
    return 'passed';
  } catch (e) {
    return e instanceof ApiError ? e.httpStatus : -1;
  }
}

describe('requireApprovedStaff', () => {
  it('lets an approved employee through', () => {
    expect(statusOf(req({ id: 1, status: 'active' }))).toBe('passed');
  });

  it('refuses every account signed in before approval — 403, not 401: the session is valid', () => {
    for (const status of ['pending_verification', 'pending_approval', 'rejected']) {
      expect(statusOf(req({ id: 1, status })), status).toBe(403);
    }
  });

  it('still answers 401 to no session and to a customer session', () => {
    expect(statusOf(req(null))).toBe(401);
    expect(statusOf(req(null, { id: 2 }))).toBe(401);
  });
});
