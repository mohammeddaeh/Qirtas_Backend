import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../http/api-error.js';
import { logger } from '../logger/logger.js';

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
    const body: ErrorEnvelope = {
      status: false,
      message: err.message,
      code: err.httpStatus,
      ...(err.details ? { errors: err.details } : {}),
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
