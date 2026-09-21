import type { NextFunction, Request, Response } from 'express';
import { realmForToken } from '../auth/realm.js';
import * as sessionService from '../auth/services/session.service.js';
import * as sessionsRepository from '../auth/repositories/sessions.repository.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: { id: number } | null;
      /**
       * The signed-in **customer**, when the token belongs to the customer realm.
       *
       * Deliberately a separate property from `user`: everything that reads
       * `req.user` (permissions, RBAC, audit) assumes a staff account, and a
       * customer id in that slot would be looked up as an employee.
       */
      customer: { id: number } | null;
      /**
       * The session backing `user`, when there is one.
       *
       * Carried so endpoints that act on sessions — rotate, "sign out my other
       * devices" — can identify the caller's own without re-resolving the token
       * they were just authenticated with. Previously such an endpoint would
       * have had to hash the Authorization header a second time.
       */
      session: { id: number; token: string } | null;
    }
  }
}

/**
 * Resolves `req.user` from the Bearer token.
 *
 * ## What it enforces, and what it deliberately does not
 *
 * Three independent conditions end a session, and all three are checked here on
 * every request rather than only at sign-in:
 *
 * 1. the token resolves to a live session (idle and absolute timeouts —
 *    `sessionService.resolveToken`);
 * 2. the owning account still exists;
 * 3. the application still permits it to be signed in
 *    (`AccountStore.canSignIn`).
 *
 * The third is why an admin suspending someone takes effect immediately rather
 * than whenever their token happens to expire. Its session row is deleted at
 * the same time, so the same dead session is not re-evaluated on every
 * subsequent request.
 *
 * **This middleware never rejects a request.** An absent, invalid or expired
 * token simply leaves `req.user = null`. Enforcement stays entirely at
 * `requireAuth()`/`requireActorId()`/`requirePermission()`, so a route's shape
 * says whether it is public — rather than that fact being spread between here
 * and there.
 *
 * ## Why the account lookup happens here and not in the session query
 *
 * It used to be a join onto `users`, reading `status` directly. That was faster
 * and it hard-coded Qirtas's account model into shared middleware — the exact
 * coupling `AccountStore` exists to remove. The cost is one indexed primary-key
 * lookup per authenticated request.
 */
export async function auth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.user = null;
  req.customer = null;
  req.session = null;

  const header = req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    next();
    return;
  }

  // The token's prefix names its realm, so exactly one sessions table is
  // probed. A customer token sent to a staff-only route still resolves — to
  // `req.customer`, which `requireAuth` does not read — so it is a 401 there.
  const realm = realmForToken(token);
  if (!realm) {
    next();
    return;
  }

  const lookup = await sessionService.resolveToken(realm, token);
  if (!lookup.ok) {
    next();
    return;
  }

  const account = await realm.store.findById(lookup.session.user_id);
  if (!account) {
    // The account vanished under a live session — only reachable through a
    // hard delete, which this system permits solely for users with zero
    // history. The orphan session is removed rather than left to the sweep.
    await sessionsRepository.deleteById(realm, lookup.session.id);
    next();
    return;
  }

  const decision = await realm.store.canSignIn(account);
  if (!decision.allowed) {
    await sessionsRepository.deleteById(realm, lookup.session.id);
    next();
    return;
  }

  if (realm.id === 'staff') req.user = { id: account.id };
  else req.customer = { id: account.id };
  req.session = { id: lookup.session.id, token };
  next();
}
