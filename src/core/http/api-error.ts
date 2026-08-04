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
    /** Optional machine-readable payload beyond `message` — e.g. a discriminator field a client branches on instead of matching free-text. */
    public readonly data?: Record<string, unknown>,
    /**
     * Optional key into src/core/i18n/messages.ts. When set, error-handler.ts
     * resolves it against req.lang ('ar'/'en') and uses that instead of
     * `message`. `message` remains the English fallback (used when the key
     * has no entry, and for logs). Most throw sites don't need this — only
     * set it for errors a real end user reads (see messages.ts scope note).
     */
    public readonly messageKey?: string,
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
  constructor(message = 'Unauthorized', messageKey?: string) {
    super(401, message, undefined, undefined, undefined, messageKey);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden', data?: Record<string, unknown>, messageKey?: string) {
    super(403, message, undefined, undefined, data, messageKey);
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
  /**
   * [messageKey] follows `req.lang` like every other user-facing refusal — a
   * rate-limit message is read by an actual person mid-task, not by a
   * developer, so leaving it English-only was an oversight.
   */
  constructor(retryAfterSeconds: number, message = 'Too many requests', messageKey?: string) {
    super(
      429,
      message,
      undefined,
      { 'Retry-After': String(retryAfterSeconds) },
      undefined,
      messageKey,
    );
  }
}

/** Generic 4xx business-rule failure that isn't one of the above. */
export class BusinessError extends ApiError {
  constructor(httpStatus: number, message: string, messageKey?: string) {
    super(httpStatus, message, undefined, undefined, undefined, messageKey);
  }
}
