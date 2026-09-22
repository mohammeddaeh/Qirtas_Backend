import { describe, it, expect, beforeAll } from 'vitest';
import type { Request } from 'express';
import { registerRealm, realmForToken, type AuthRealm } from '../../auth/realm.js';
import { ApiError } from '../api-error.js';
import { readAccess } from '../route-marker.js';
import {
  actorOf,
  requireCustomer,
  requireSignedIn,
  requireVerifiedCustomer,
} from '../require-customer.js';

/**
 * Failing here looks like nothing: a customer token that resolves as staff (or
 * an unverified customer that passes the purchase gate) still returns 200 —
 * the wrong person simply gets in. So every case is paired with its opposite.
 */

function realmStub(id: 'staff' | 'customer', prefix: string, verifiedAt: Date | null): AuthRealm {
  return {
    id,
    tokenPrefix: prefix,
    sessions: {} as never,
    tokens: {} as never,
    store: {
      findById: async () => ({
        id: 1,
        email: 'a@b.c',
        passwordHash: 'x',
        emailVerifiedAt: verifiedAt,
        status: 'active',
      }),
    } as never,
  };
}

const req = (p: Partial<Request>) => p as Request;

function run(mw: (r: Request, s: never, n: (e?: unknown) => void) => unknown, r: Request) {
  return new Promise<unknown>((resolve) => {
    void Promise.resolve(mw(r, {} as never, (e) => resolve(e)));
  });
}

describe('realm selection by token prefix', () => {
  beforeAll(() => {
    registerRealm(realmStub('staff', '', null));
    registerRealm(realmStub('customer', 'c_', null));
  });

  it('routes a c_ token to the customer realm and anything else to staff', () => {
    expect(realmForToken('c_abc')?.id).toBe('customer');
    expect(realmForToken('abc')?.id).toBe('staff');
  });
});

describe('access tiers', () => {
  it('staff is not a customer, and a customer is not staff', () => {
    expect(actorOf(req({ user: { id: 1, status: 'active' }, customer: null })).realm).toBe('staff');
    expect(actorOf(req({ user: null, customer: { id: 2 } })).realm).toBe('customer');
    expect(() => actorOf(req({ user: null, customer: null }))).toThrow();
    // a staff session must not satisfy the customer tier
    expect(() => requireCustomer(req({ user: { id: 1, status: 'active' }, customer: null }), {} as never, () => {})).toThrow();
    // …and both realms satisfy "signed in"
    expect(() => requireSignedIn(req({ user: { id: 1, status: 'active' }, customer: null }), {} as never, () => {})).not.toThrow();
  });

  it('classifies each guard so check:permissions can see it', () => {
    expect(readAccess(requireSignedIn)?.kind).toBe('authenticated');
    expect(readAccess(requireCustomer)?.kind).toBe('customer');
    expect(readAccess(requireVerifiedCustomer)?.kind).toBe('verified');
  });
});

describe('requireVerifiedCustomer', () => {
  it('refuses an unproven email with the dedicated key', async () => {
    registerRealm(realmStub('customer', 'c_', null));
    const err = (await run(requireVerifiedCustomer as never, req({ customer: { id: 1 } }))) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.httpStatus).toBe(403);
    expect(err.messageKey).toBe('email_verification_required');
  });

  it('lets a proven email through', async () => {
    registerRealm(realmStub('customer', 'c_', new Date()));
    expect(await run(requireVerifiedCustomer as never, req({ customer: { id: 1 } }))).toBeUndefined();
  });

  it('does not let a staff session through the purchase gate', async () => {
    registerRealm(realmStub('customer', 'c_', new Date()));
    const err = await run(requireVerifiedCustomer as never, req({ user: { id: 1, status: 'active' }, customer: null }));
    expect(err).toBeInstanceOf(Error);
  });
});
