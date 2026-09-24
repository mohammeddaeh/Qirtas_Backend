import { describe, it, expect } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../http/api-error.js';
import { validate } from '../validate.js';

/**
 * A 422 that names no field is a 422 nobody can act on.
 *
 * Zod files whole-object problems — `.strict()` above all — under `formErrors`,
 * while per-field problems go to `fieldErrors`. Sending only the second answers
 * an unknown query key with `{"message":"Validation failed","errors":{}}`. The
 * status code is right, the log line is right, and the one thing missing is
 * which key was refused. That is what happened to
 * `GET /inventory/receipts?branch_id=32` and it cost a live debugging session,
 * because the client, the server log and the response all agreed on nothing.
 *
 * The opposite case is half the test: echoing every issue into one bucket
 * would satisfy the strict case and destroy the per-field map that the Flutter
 * `server_message_extractor` reads to put a message under the right input.
 */

function run(schema: z.ZodSchema, value: unknown): Record<string, string[]> | 'passed' {
  const req = { query: value } as unknown as Request;
  try {
    validate(schema, 'query')(req, {} as Response, (() => {}) as NextFunction);
    return 'passed';
  } catch (e) {
    return e instanceof ApiError ? (e.details ?? {}) : { thrown: ['not an ApiError'] };
  }
}

const strictPage = z.object({ page: z.coerce.number().int().min(1) }).strict();

describe('validate()', () => {
  it('names the unknown key instead of an empty errors map', () => {
    const errors = run(strictPage, { page: '1', branch_id: '32' });

    expect(errors).not.toBe('passed');
    expect(Object.keys(errors as object).length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toContain('branch_id');
  });

  it('still reports a bad field under its own name', () => {
    // The inverse: a fix that dumped everything into one bucket would pass the
    // case above and leave every form unable to mark the input that failed.
    const errors = run(strictPage, { page: '0' });

    expect(errors).toHaveProperty('page');
    expect((errors as Record<string, string[]>).page?.length ?? 0).toBeGreaterThan(0);
  });

  it('lets a valid query through, coerced', () => {
    const req = { query: { page: '3' } } as unknown as Request;
    let called = false;

    validate(strictPage, 'query')(req, {} as Response, (() => {
      called = true;
    }) as NextFunction);

    expect(called).toBe(true);
    expect(req.query).toEqual({ page: 3 });
  });
});
