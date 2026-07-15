/**
 * Base error for anything that should reach the client as a structured
 * error envelope: { status: false, message, code, errors? }.
 *
 * Services/controllers throw these — never build an error response body
 * by hand. See src/core/middleware/error-handler.ts.
 */
export class ApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    public readonly details?: Record<string, string[]>,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found') {
    super(404, message);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

/** 422 — always carries a Laravel-style { field: [messages] } map. */
export class ValidationError extends ApiError {
  constructor(details: Record<string, string[]>, message = 'Validation failed') {
    super(422, message, details);
  }
}

/**
 * 409 — reserved for the future offline-sync feature. Body is expected to
 * carry server_version/client_version/conflict_fields (see docs/rest_api.md).
 * Not used by any endpoint in this skeleton yet.
 */
export class ConflictError extends ApiError {
  constructor(message = 'Conflict') {
    super(409, message);
  }
}

export class RateLimitError extends ApiError {
  constructor(retryAfterSeconds: number, message = 'Too many requests') {
    super(429, message, undefined, { 'Retry-After': String(retryAfterSeconds) });
  }
}

/** Generic 4xx business-rule failure that isn't one of the above. */
export class BusinessError extends ApiError {
  constructor(httpStatus: number, message: string) {
    super(httpStatus, message);
  }
}
