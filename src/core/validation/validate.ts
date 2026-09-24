import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { ValidationError } from '../http/api-error.js';

type Source = 'body' | 'query' | 'params';

/**
 * Validates req[source] against a zod schema. On failure, throws
 * ValidationError(422) with a Laravel-style { field: [messages] } map —
 * the shape the Flutter server_message_extractor checks for first.
 * On success, replaces req[source] with the parsed/coerced value (so e.g.
 * `page`/`limit` become real numbers downstream).
 */
export function validate(schema: ZodSchema, source: Source) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const flat = result.error.flatten();
      const fieldErrors = flat.fieldErrors as Record<string, string[]>;
      // A refusal that names no field is a refusal nobody can act on. Zod files
      // whole-object issues — `.strict()` above all — under `formErrors`, not
      // `fieldErrors`, so sending `fieldErrors` alone answered an unknown query
      // key with `{"message":"Validation failed","errors":{}}`: 422 with the
      // reason stripped out, on the client and in the log. It cost a live
      // debugging session on `GET /inventory/receipts?branch_id=…`.
      if (flat.formErrors.length > 0) fieldErrors[source] = flat.formErrors;
      throw new ValidationError(fieldErrors);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any)[source] = result.data;
    next();
  };
}
