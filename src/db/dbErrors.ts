import { DatabaseError } from '../errors/AppError';
import type { Db } from './connection';

/**
 * Translates low-level Postgres / network failures into application errors.
 *
 * Repositories wrap their public methods with `withDbErrorHandling`, so this is
 * the single try/catch for every query, instead of one per method.
 */

/** A Postgres SQLSTATE error code, e.g. "42P01" (undefined table). */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * SQLSTATEs where retrying later can succeed, so they become 503s rather than 500s:
 * 08 connection problems, 53 out of resources (e.g. too many connections),
 * 57P01-3 server shutting down, 57014 statement timeout, 55P03 lock not
 * available, 40001 / 40P01 serialization failure / deadlock.
 */
const RETRYABLE_SQLSTATE = /^(08|53|57P0[1-3]|57014|55P03|40001|40P01)/;

/** Node socket errors raised when the database host can't be reached. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Connection failures the pg driver reports without any code. */
const DRIVER_CONNECTION_MESSAGE =
  /Connection terminated|timeout exceeded when trying to connect|Cannot use a pool after calling end/i;

type Classification = 'retryable' | 'permanent' | 'not-a-database-error';

function classify(error: unknown): Classification {
  if (!(error instanceof Error)) return 'not-a-database-error';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (NETWORK_ERROR_CODES.has(code)) return 'retryable';
    if (SQLSTATE.test(code)) return RETRYABLE_SQLSTATE.test(code) ? 'retryable' : 'permanent';
  }
  return DRIVER_CONNECTION_MESSAGE.test(error.message) ? 'retryable' : 'not-a-database-error';
}

/**
 * Converts a database failure into a DatabaseError with a client-safe message.
 * The original error (with SQL details) is kept as `cause` for the server log.
 * Anything that isn't a database failure is a bug: rethrown as-is.
 */
export function toDatabaseError(error: unknown, operation: string): unknown {
  const kind = classify(error);
  if (kind === 'not-a-database-error') return error;

  const retryable = kind === 'retryable';
  const message = retryable
    ? `The database is unavailable; could not ${operation}. Please retry.`
    : `Could not ${operation} due to a database error.`;
  return new DatabaseError(message, { cause: error, retryable });
}

/**
 * Wraps a data-access function so any database failure surfaces as a DatabaseError.
 *
 * @param db        The connection `fn` uses; checked first, so a request still in
 *                  flight during shutdown gets a clear retryable error.
 * @param operation Human-readable description used in the error message, e.g. "list users".
 */
export function withDbErrorHandling<Args extends unknown[], Result>(
  db: Db,
  operation: string,
  fn: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    if (!db.isOpen) {
      throw new DatabaseError(`The database is not available; could not ${operation}.`, {
        cause: new Error('Database connection is closed'),
        retryable: true,
      });
    }
    try {
      return await fn(...args);
    } catch (error) {
      throw toDatabaseError(error, operation);
    }
  };
}
