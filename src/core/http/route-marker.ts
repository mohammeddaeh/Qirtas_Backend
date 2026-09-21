import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Lets a route **say what it is** in a way a checker can read back.
 *
 * ## The problem this solves
 *
 * A guard that is missing looks exactly like a route that is meant to be
 * public. `usersRouter.get('/:id', asyncHandler(controller.getOne))` is either
 * a deliberate open endpoint or a forgotten `requirePermission` — and no
 * reviewer, type checker or linter can tell which. Qirtas is past forty guarded
 * routes across ten routers; that ambiguity is where an unprotected endpoint
 * comes from, not from anyone deciding to skip a guard.
 *
 * Marking makes the two cases distinguishable. Every handler mounted by
 * `requireAuth`, `requirePermission()` or [publicRoute] carries a tag, and
 * `npm run check:permissions` fails on any route carrying none.
 *
 * Same argument as `core/i18n/check-message-keys.ts`, applied to guards:
 * **a written rule with no check is a suggestion.**
 */

export type RouteAccessKind =
  /** Deliberately reachable without a token — login, register, bootstrap-super-admin. */
  | 'public'
  /** Any signed-in account, staff or customer. No permission required. */
  | 'authenticated'
  /** A signed-in **customer** (any email-verification state). Browsing-plus tier: account, cart, profile. */
  | 'customer'
  /** A signed-in customer whose **email is proven** — the tier every purchase-like action requires. */
  | 'verified'
  /** Requires [RouteAccess.keys]. */
  | 'permission';

export interface RouteAccess {
  kind: RouteAccessKind;
  /** Present only for `permission`. */
  keys?: readonly string[];
}

/**
 * A property rather than a `Symbol`: the checker reads it off handlers pulled
 * out of Express' own router stack, and a string property survives every
 * wrapper in this codebase without each one having to forward a symbol.
 */
const ACCESS_PROPERTY = '__routeAccess';

export function markAccess<T>(handler: T, access: RouteAccess): T {
  Object.defineProperty(handler, ACCESS_PROPERTY, {
    value: access,
    enumerable: false,
    configurable: true,
  });
  return handler;
}

export function readAccess(handler: unknown): RouteAccess | undefined {
  if (typeof handler !== 'function') return undefined;
  return (handler as unknown as Record<string, unknown>)[ACCESS_PROPERTY] as
    | RouteAccess
    | undefined;
}

/**
 * Declares, at the route, that anonymous access is intended.
 *
 * Runtime cost is one `next()`. Its whole job is to be a **positive statement**
 * where there would otherwise be an absence — so "this endpoint is public" is
 * something the author wrote, rather than something a reader infers from a
 * missing line.
 *
 * ```ts
 * authRouter.post('/login', publicRoute, validate(loginBodySchema, 'body'), …);
 * ```
 */
export const publicRoute: RequestHandler = markAccess(
  (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  },
  { kind: 'public' },
);
