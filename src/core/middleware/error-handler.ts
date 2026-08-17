import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../http/api-error.js';
import { logger } from '../logger/logger.js';
import { resolveMessage } from '../i18n/messages.js';

/**
 * The error envelope shape. `status` is ALWAYS boolean false here (mirrors
 * SuccessEnvelope.status === true). `errors` is only present for 422
 * validation failures, Laravel-style: { field: [messages] }.
 */
export interface ErrorEnvelope {
  status: false;
  message: string;
  code: number;
  errors?: Record<string, string[]>;
  /** Optional machine-readable payload beyond `message` — see ApiError.data. */
  data?: Record<string, unknown>;
}

/**
 * Terminal error-handling middleware — MUST be registered last, after all
 * routers. Controllers/services never build an error response body by hand;
 * they throw ApiError subclasses (or let a ZodError bubble) and this is the
 * single place that turns it into the wire shape.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (err instanceof ApiError) {
    if (err.headers) {
      for (const [key, value] of Object.entries(err.headers)) {
        res.setHeader(key, value);
      }
    }
    // `message_key` rides along inside `data` so a client can branch on WHICH
    // rule refused it, not on the wording. Two different refusals often share a
    // status code — a duplicate role NAME and a duplicate PERMISSION SET are
    // both 409, but only the second is overridable with `force` — and matching
    // translated prose to tell them apart breaks the moment a word changes.
    const data =
      err.messageKey !== undefined
        ? { ...(err.data ?? {}), message_key: err.messageKey }
        : err.data;

    const body: ErrorEnvelope = {
      status: false,
      message: resolveMessage(err.messageKey, req.lang, err.message),
      code: err.httpStatus,
      ...(err.details ? { errors: err.details } : {}),
      ...(data ? { data } : {}),
    };
    res.status(err.httpStatus).json(body);
    return;
  }

  // `express.json()` rejected the body before any route saw it — malformed
  // JSON, or a body over the size limit.
  //
  // Without this the throw is an ordinary `SyntaxError`, so it fell through to
  // the catch-all below and the client was told **500 internal server error**
  // for a request it had itself sent wrong. That is the worst possible answer
  // to the most recoverable class of failure: `DioFailureMapper` on the Flutter
  // side turns 500 into `ServerFailure`, which is deliberately `canRetry: false`
  // because a genuine 500 does not fix itself — so the user got a dead end, and
  // the log said the server was broken when nothing was.
  //
  // A truncated upload on a flaky mobile connection lands here too, which is
  // exactly the case that must say "send it again".
  const bodyParse = asBodyParserError(err);
  if (bodyParse !== null) {
    const body: ErrorEnvelope = {
      status: false,
      message: resolveMessage(bodyParse.messageKey, req.lang, bodyParse.message),
      code: bodyParse.httpStatus,
    };
    res.status(bodyParse.httpStatus).json(body);
    return;
  }

  // Defensive: a ZodError that escaped validate() (shouldn't normally happen).
  if (err instanceof ZodError) {
    const body: ErrorEnvelope = {
      status: false,
      message: 'Validation failed',
      code: 422,
      errors: err.flatten().fieldErrors as Record<string, string[]>,
    };
    res.status(422).json(body);
    return;
  }

  // A dependency being unreachable is **not** an internal error, and calling it
  // one costs the client its retry: 500 tells the app "this is broken", so it
  // shows a dead end at the exact moment waiting a few seconds would have
  // worked. 503 says "come back shortly", which is both true and actionable.
  //
  // The common case by far is the database going away — a restart, a failover,
  // a connection pool exhausted under load. It surfaces as a driver-level
  // socket error, never as an ApiError, so without this it lands in the
  // catch-all below and every request during a ten-second failover is reported
  // to users as the application being broken.
  if (isDependencyUnavailable(err)) {
    logger.error({ err }, 'Dependency unavailable — answering 503');
    res.setHeader('Retry-After', '5');
    const body: ErrorEnvelope = {
      status: false,
      message: 'Service temporarily unavailable',
      code: 503,
    };
    res.status(503).json(body);
    return;
  }

  logger.error({ err }, 'Unhandled error');
  const body: ErrorEnvelope = {
    status: false,
    message: 'Internal server error',
    code: 500,
  };
  res.status(500).json(body);
}

/**
 * Classifies a body-parser rejection, or returns `null` if this is not one.
 *
 * Matched on `type` — the stable discriminator body-parser sets on every error
 * it raises — never on the message, for the same reason `ErrorEnvelope.data`
 * exists: message text is prose that changes between library versions.
 */
function asBodyParserError(
  err: unknown,
): { httpStatus: number; message: string; messageKey: string } | null {
  if (typeof err !== 'object' || err === null) return null;

  const type = (err as { type?: unknown }).type;
  if (typeof type !== 'string') return null;

  switch (type) {
    case 'entity.parse.failed':
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return { httpStatus: 400, message: 'Malformed request body', messageKey: 'body_malformed' };

    case 'entity.too.large':
      return { httpStatus: 413, message: 'Request body is too large', messageKey: 'body_too_large' };

    // `request.aborted` — the client hung up mid-body. Nothing to answer to,
    // but naming it keeps it out of the 500 bucket in the logs.
    case 'request.aborted':
      return { httpStatus: 400, message: 'Request was aborted', messageKey: 'body_malformed' };

    default:
      return null;
  }
}

/**
 * Socket-level codes that mean "the thing I depend on is not answering", as
 * opposed to "my code threw".
 *
 * Matched on `code`, never on the message text: driver messages are prose that
 * changes between library versions, and a branch built on them breaks silently
 * on an upgrade — the same trap `ErrorEnvelope.data` exists to close on the
 * client side.
 *
 * `ECONNRESET` is deliberately absent: it is as often a client hanging up
 * mid-request as it is a dependency dying, and answering 503 to the first case
 * would tell healthy clients to retry a request that already succeeded.
 */
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', // nothing listening on the port
  'ENOTFOUND', // DNS gave nothing — host is gone or not up yet
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT', // the dependency accepted nothing in time
  'EPIPE',
  '57P01', // postgres: admin_shutdown
  '57P03', // postgres: cannot_connect_now (still starting up)
  '08006', // postgres: connection_failure
  '08001', // postgres: sqlclient_unable_to_establish_sqlconnection
]);

function isDependencyUnavailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return true;

  // Drivers routinely wrap the socket error, so the code that matters sits one
  // level down. Checked explicitly rather than walking the chain: an unbounded
  // walk can follow a cycle, and one level is where every case observed lives.
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string' && UNAVAILABLE_CODES.has(causeCode)) {
      return true;
    }
  }

  return false;
}
