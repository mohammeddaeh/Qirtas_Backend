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

  logger.error({ err }, 'Unhandled error');
  const body: ErrorEnvelope = {
    status: false,
    message: 'Internal server error',
    code: 500,
  };
  res.status(500).json(body);
}
