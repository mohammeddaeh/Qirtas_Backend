import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from './api-error.js';
import { markAccess } from './route-marker.js';
import { getRealm, type RealmId } from '../auth/realm.js';

/**
 * The customer side of route protection — the "access tiers" of
 * docs/reference/customer_accounts.md §13, on the server.
 *
 * ```
 * publicRoute            guest can call it
 * requireSignedIn        any account (staff or customer)
 * requireCustomer        a customer, verified or not      → account, cart, profile
 * requireVerifiedCustomer a customer with a PROVEN email  → checkout, orders, wholesale request
 * requirePermission(k)   staff, by RBAC key
 * ```
 *
 * Every one carries a route marker, so `npm run check:permissions` fails on a
 * route that picks none — a purchase endpoint cannot be left open by omission.
 */

/** Any signed-in account and which population it belongs to. */
export function actorOf(req: Request): { realm: RealmId; id: number } {
  if (req.user) return { realm: 'staff', id: req.user.id };
  if (req.customer) return { realm: 'customer', id: req.customer.id };
  throw new UnauthorizedError('Authentication required', 'authentication_required');
}

export function requireCustomerId(req: Request): number {
  if (!req.customer) {
    // Staff token on a customer route is the same 401 as no token: a staff
    // session is not a customer session, and saying "wrong kind of account"
    // would only help someone probing which realm an address lives in.
    throw new UnauthorizedError('Authentication required', 'authentication_required');
  }
  return req.customer.id;
}

export function requireSignedIn(req: Request, _res: Response, next: NextFunction): void {
  actorOf(req);
  next();
}
markAccess(requireSignedIn, { kind: 'authenticated' });

export function requireCustomer(req: Request, _res: Response, next: NextFunction): void {
  requireCustomerId(req);
  next();
}
markAccess(requireCustomer, { kind: 'customer' });

/**
 * Refuses a customer whose email is not proven, with a **dedicated key**.
 *
 * `email_verification_required` — not a generic 403 — because the client's
 * correct reaction is to open the code screen, not to show an error. The check
 * reads the store on every call rather than trusting a flag cached on the
 * session: verifying mid-session must unlock purchasing at once, and a
 * suspended account must not keep buying on a stale one.
 */
export async function requireVerifiedCustomer(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = requireCustomerId(req);
    const account = await getRealm('customer').store.findById(id);
    if (!account) {
      throw new UnauthorizedError('Authentication required', 'authentication_required');
    }
    if (account.emailVerifiedAt === null) {
      throw new ForbiddenError(
        'Confirm your email address to continue',
        { email_verified: false },
        'email_verification_required',
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}
markAccess(requireVerifiedCustomer, { kind: 'verified' });
