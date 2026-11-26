/**
 * Errors the application raises on purpose. Each carries the HTTP status and a
 * stable machine-readable code, so the error middleware can respond without
 * knowing about individual cases. Anything that is NOT an AppError is treated
 * as an unexpected bug (500) and its details are hidden from the client.
 *
 * `cause` keeps the original low-level error (e.g. the Postgres error) attached
 * for server logs, while `message` stays safe to show to clients.
 */
export class AppError extends Error {
  /** When set, sent as the `Retry-After` header: how long the client should wait before retrying. */
  readonly retryAfterSeconds?: number;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

/**
 * Suggested wait before retrying a temporarily unavailable database (dropped
 * connection, pooler restart, too many connections). A short pause is usually
 * enough; clients should still back off on repeated failures.
 */
export const DB_RETRY_AFTER_SECONDS = 1;

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message);
  }
}

/**
 * A database operation failed while serving a request.
 *
 * - retryable (e.g. the DB is unreachable or overloaded): 503 DATABASE_UNAVAILABLE,
 *   so the client knows trying again shortly may succeed.
 * - otherwise (missing table, bad SQL, constraint violation): 500 DATABASE_ERROR.
 */
export class DatabaseError extends AppError {
  readonly retryable: boolean;

  constructor(message: string, options: { cause: unknown; retryable: boolean }) {
    super(
      options.retryable ? 503 : 500,
      options.retryable ? 'DATABASE_UNAVAILABLE' : 'DATABASE_ERROR',
      message,
      {
        cause: options.cause,
        retryAfterSeconds: options.retryable ? DB_RETRY_AFTER_SECONDS : undefined,
      },
    );
    this.retryable = options.retryable;
  }
}
