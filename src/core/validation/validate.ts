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
      const fieldErrors = result.error.flatten().fieldErrors as Record<string, string[]>;
      throw new ValidationError(fieldErrors);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any)[source] = result.data;
    next();
  };
}
