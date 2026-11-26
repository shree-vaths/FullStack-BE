import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { DatabaseConnectionError, openDatabase } from '../src/db/connection';
import { toDatabaseError, withDbErrorHandling } from '../src/db/dbErrors';
import { seedDatabase } from '../src/db/seedData';
import { DB_RETRY_AFTER_SECONDS, DatabaseError } from '../src/errors/AppError';
import { createTestDb, type TestDb } from './testDb';

/** Failure scenarios: connecting to the database, and queries failing mid-request. */

describe('openDatabase', () => {
  // Port 1 on localhost: nothing listens there, so the connection is refused at once.
  const unreachable = 'postgresql://app:s3cret-password@127.0.0.1:1/app';

  it('fails clearly when the database cannot be reached, keeping the cause', async () => {
    const attempt = openDatabase({ connectionString: unreachable, ssl: false });
    await expect(attempt).rejects.toThrow(DatabaseConnectionError);
    await expect(attempt).rejects.toThrow(/Could not connect to the database at 127\.0\.0\.1:1/);
    await expect(attempt).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } });
  });

  it('never puts the password in the error message', async () => {
    const error = await openDatabase({ connectionString: unreachable, ssl: false }).catch((e) => e);
    expect((error as Error).message).not.toContain('s3cret-password');
  });
});

describe('toDatabaseError', () => {
  /** Shaped like the errors pg / Node raise: an Error with a `code`. */
  const errorWithCode = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });

  it.each([
    ['08006', 'connection failure'],
    ['53300', 'too many connections'],
    ['57P01', 'server shutting down'],
    ['57014', 'statement timeout'],
    ['40001', 'serialization failure'],
    ['ECONNREFUSED', 'host refused the connection'],
    ['ETIMEDOUT', 'network timeout'],
  ])('treats %s (%s) as retryable (503)', (code) => {
    const error = toDatabaseError(errorWithCode(code), 'list users');
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      retryable: true,
      retryAfterSeconds: DB_RETRY_AFTER_SECONDS,
    });
  });

  it('treats a dropped connection reported without a code as retryable', () => {
    const error = toDatabaseError(new Error('Connection terminated unexpectedly'), 'list users');
    expect(error).toMatchObject({ status: 503, retryable: true });
  });

  it.each([
    ['42P01', 'undefined table'],
    ['42601', 'syntax error'],
    ['23505', 'unique violation'],
    ['XX000', 'internal error'],
  ])('treats %s (%s) as a 500', (code) => {
    expect(toDatabaseError(errorWithCode(code), 'list users')).toMatchObject({
      status: 500,
      code: 'DATABASE_ERROR',
      retryable: false,
      retryAfterSeconds: undefined,
    });
  });

  it('keeps the original error as `cause` but not in the client message', () => {
    const original = errorWithCode('42P01');
    const error = toDatabaseError(original, 'list users') as DatabaseError;
    expect(error.cause).toBe(original);
    expect(error.message).not.toContain('simulated');
  });

  it('passes non-database errors (bugs) through unchanged', () => {
    const bug = new TypeError('x is undefined');
    expect(toDatabaseError(bug, 'list users')).toBe(bug);
  });
});

describe('withDbErrorHandling', () => {
  it('reports a closed connection as retryable', async () => {
    const db = await createTestDb();
    const query = withDbErrorHandling(db, 'list users', () => db.query('SELECT 1'));
    await db.close();

    await expect(query()).rejects.toThrow(DatabaseError);
    await expect(query()).rejects.toThrow(/not available/);
  });
});

describe('API behaviour when the database fails', () => {
  let db: TestDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    // Server errors are logged by design; keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = await createTestDb();
    await seedDatabase(db, { userCount: 3, transactionCount: 30 });
    app = createApp(db);
  });

  afterEach(async () => {
    if (db.isOpen) await db.close();
    vi.restoreAllMocks();
  });

  it('health check reports ok while the database is reachable', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.data).toEqual({ status: 'ok', database: 'ok' });
  });

  it('health check returns 503 with Retry-After once the database is gone', async () => {
    await db.close();
    const res = await request(app).get('/api/health').expect(503);
    expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe(String(DB_RETRY_AFTER_SECONDS));
  });

  it('returns 503 with Retry-After when the connection is closed mid-flight', async () => {
    await db.close();
    const res = await request(app).get('/api/users').expect(503);
    expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe(String(DB_RETRY_AFTER_SECONDS));
  });

  it('returns a 500 without leaking SQL details when a query fails', async () => {
    await db.query('DROP TABLE transactions'); // simulate a broken/migrated schema

    const res = await request(app).get('/api/users/1/transactions').expect(500);
    expect(res.body.error.code).toBe('DATABASE_ERROR');
    // Permanent failure: retrying won't help, so no Retry-After hint.
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.body.error.message).not.toMatch(/relation|does not exist|SELECT|postgres/i);
    // ...but the server log gets the full error, including the Postgres cause.
    expect(console.error).toHaveBeenCalled();
  });

  it('keeps serving other endpoints when one query fails', async () => {
    await db.query('DROP TABLE transactions');
    await request(app).get('/api/users/1/transactions').expect(500);
    await request(app).get('/api/users').expect(200);
  });
});
