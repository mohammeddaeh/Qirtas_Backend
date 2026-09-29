import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { resolveMessage, type Lang } from '../i18n/messages.js';
import { logger } from '../logger/logger.js';

/**
 * Multi-select actions on a list — `POST /<module>/bulk`.
 *
 * ## The one rule this exists to keep
 *
 * A bulk action is the single-record action **run N times**, never a second
 * implementation of it. Each id goes through the exact service function the
 * one-by-one endpoint calls, so every rule (what may be deleted, what counts as
 * archived, the last-holder guards) and every audit entry is identical whether
 * the admin ticked ten rows or pressed the button ten times. A bulk path with
 * its own `WHERE id IN (…)` would be a second copy of those rules — and the
 * first one to drift does so silently, because both paths still answer 200.
 *
 * ## Partial success is a 200
 *
 * Ten rows ticked, seven deletable: that is not a failed request, it is seven
 * results and three reasons. Each refusal carries the same `message_key` the
 * single endpoint would have answered with, translated for this request's
 * language, so the client can say *why* per row instead of "some failed".
 * Only request-level problems (validation, permission, session) are errors.
 *
 * Adding bulk to a module is: a body schema from [bulkBodySchema], a service
 * function that maps the action to the existing single-record calls through
 * [runBulk], one route. See `features/identity` → branches for the pilot.
 */

/** A request may name at most this many records. */
export const BULK_MAX_IDS = 100;

/**
 * `{ action, ids }` for the given actions.
 *
 * `ids` is 1..[BULK_MAX_IDS] positive integers; duplicates are dropped
 * (first occurrence wins, order kept) so the same row is never acted on twice
 * — a second `delete` of the same id would come back as a confusing
 * "not found" refusal for a row the client just saw succeed.
 *
 * Returns the plain object (not yet `.strict()`/refined) so a module can
 * `.extend()` it with action-specific fields — e.g. `status` for
 * `set_status` — and then call [requireFieldForActions].
 */
export function bulkBodySchema<const A extends readonly [string, ...string[]]>(actions: A) {
  return z.object({
    action: z.enum(actions),
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(BULK_MAX_IDS)
      .transform((ids) => [...new Set(ids)]),
  });
}

/**
 * `field` is required when `action` is one of [actions], and forbidden
 * otherwise. Forbidden, not ignored: a `status` sent with `delete` means the
 * client thinks it is doing something it is not, and saying so beats doing the
 * other thing quietly.
 *
 * Use inside `.superRefine(...)`. The issue lands on `field`, so the 422 names
 * the input to fix.
 */
export function requireFieldForActions(
  value: Record<string, unknown> & { action: string },
  ctx: z.RefinementCtx,
  field: string,
  actions: readonly string[],
): void {
  const needed = actions.includes(value.action);
  const present = value[field] !== undefined;
  if (needed && !present) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `Required when action is ${actions.join(' or ')}`,
    });
  } else if (!needed && present) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `Not allowed when action is ${value.action}`,
    });
  }
}

export interface BulkRefusal {
  id: number;
  message_key: string;
  message: string;
}

export interface BulkResult {
  /** Ids the action applied to, in request order. */
  done: number[];
  refused: BulkRefusal[];
}

/**
 * A 404 carries no `messageKey` anywhere in this codebase (`NotFoundError` is
 * structural — the client renders its own text for a whole-screen 404). A
 * per-row refusal has no screen of its own, so it needs a key; this is it.
 */
export const BULK_NOT_FOUND_KEY = 'record_not_found';

/** Any other keyless `ApiError` — should not happen for a business refusal (`check:messages` enforces keys), but the row must still say something. */
export const BULK_REFUSED_KEY = 'record_action_refused';

/** A non-`ApiError` throw on one row — logged at error level, never swallowed. */
export const BULK_FAILED_KEY = 'record_action_failed';

/**
 * Runs [fn] once per id, **sequentially** — in request order, and without N
 * concurrent writers contending for the same locks (archiving two branches
 * both touches the audit log and may touch shared rows).
 *
 * Each call is whatever the single-record endpoint is — its own transaction if
 * it has one — so one refusal never rolls back another row's success.
 *
 * - `ApiError` → a refusal with its `messageKey`, translated for [lang] by the
 *   same `resolveMessage` the error handler uses.
 * - Anything else (a bug, a constraint nobody guarded) → logged with the id,
 *   and recorded as a [BULK_FAILED_KEY] refusal. Not rethrown: by then earlier
 *   rows are already committed, and a 500 would tell the client nothing
 *   happened when seven rows did. The client gets the truth per row, and the
 *   log gets the stack.
 */
export async function runBulk(
  ids: readonly number[],
  lang: Lang,
  fn: (id: number) => Promise<unknown>,
): Promise<BulkResult> {
  const done: number[] = [];
  const refused: BulkRefusal[] = [];

  for (const id of ids) {
    try {
      await fn(id);
      done.push(id);
    } catch (err) {
      refused.push(toRefusal(id, err, lang));
    }
  }

  return { done, refused };
}

function toRefusal(id: number, err: unknown, lang: Lang): BulkRefusal {
  if (err instanceof ApiError) {
    const key = err.messageKey ?? (err.httpStatus === 404 ? BULK_NOT_FOUND_KEY : BULK_REFUSED_KEY);
    // A keyless error keeps its own English text as the fallback only when the
    // generic key somehow has no entry — the generic key always wins otherwise,
    // so an Arabic reader never gets "Branch not found" in English.
    return { id, message_key: key, message: resolveMessage(key, lang, err.message) };
  }

  logger.error({ err, id }, 'Bulk action failed unexpectedly on one record');
  return {
    id,
    message_key: BULK_FAILED_KEY,
    message: resolveMessage(BULK_FAILED_KEY, lang, 'Could not apply the action to this record'),
  };
}

/** Mirrors [BulkResult] for OpenAPI generation only — keep the two in step. */
export const bulkResultResponseSchema = z.object({
  done: z.array(z.number().int()),
  refused: z.array(
    z.object({ id: z.number().int(), message_key: z.string(), message: z.string() }),
  ),
});
