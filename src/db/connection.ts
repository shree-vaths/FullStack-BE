import pg from 'pg';

/**
 * The database as the rest of the app sees it: run a query, run several in
 * one transaction, close. Kept this small so tests can supply an in-process
 * Postgres (PGlite) behind the same interface instead of a network server.
 */
export interface Queryable {
  /** Runs one statement with `$1, $2, ...` placeholders bound to `params`. */
  query<Row extends object>(sql: string, params?: unknown[]): Promise<Row[]>;
}

export interface Db extends Queryable {
  /** False once `close()` has been called. */
  readonly isOpen: boolean;
  /**
   * Runs `fn` inside one transaction: committed if it resolves, rolled back if it throws.
   * `readOnly` uses REPEATABLE READ, so every query in `fn` sees the same snapshot.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: { readOnly?: boolean }): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  connectionString: string;
  /** Encrypt the connection (required by Supabase). */
  ssl: boolean;
}

// Return BIGINT ids/counts as numbers (pg defaults to strings to avoid
// overflow; ours stay far below 2^53) and DATE columns as plain "YYYY-MM-DD"
// strings (pg's default Date object would shift with the server's time zone).
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

/** Connections kept open to the database. Supabase's pooler caps them per project. */
const POOL_SIZE = 5;
/** Fail a request instead of hanging when no connection can be made. */
const CONNECT_TIMEOUT_MS = 5_000;
/** Server-side cap on a single statement, so a runaway query can't hold a connection. */
const STATEMENT_TIMEOUT_MS = 10_000;

const READ_ONLY_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY';

/** The database could not be reached or used. Raised at startup, not per request. */
export class DatabaseConnectionError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'DatabaseConnectionError';
  }
}

/** "host:port" of a connection string, for messages. Never includes the password. */
function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || 5432}`;
  } catch {
    return '(invalid DATABASE_URL)';
  }
}

/** Wraps a pg connection pool in the Db interface. */
function createPostgresDb({ connectionString, ssl }: DatabaseOptions): Db {
  const pool = new pg.Pool({
    connectionString,
    // Encrypted, but the certificate isn't checked against a CA: Supabase
    // signs with its own CA, which Node doesn't trust by default.
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: POOL_SIZE,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  // An idle connection dropped by the server (e.g. a pooler restart) is
  // reported here. Without a listener Node would crash the process; the pool
  // simply opens a new connection next time.
  pool.on('error', (error) => console.error('Idle database connection failed:', error));

  const query: Queryable['query'] = async (sql, params) => (await pool.query(sql, params)).rows;

  return {
    get isOpen() {
      return !pool.ending;
    },
    query,
    async transaction(fn, options) {
      const client = await pool.connect();
      try {
        await client.query(options?.readOnly ? READ_ONLY_BEGIN : 'BEGIN');
        const result = await fn({
          query: async (sql, params) => (await client.query(sql, params)).rows,
        });
        await client.query('COMMIT');
        client.release();
        return result;
      } catch (error) {
        // If ROLLBACK fails too, the connection is unusable: destroy it
        // rather than returning it to the pool.
        await client.query('ROLLBACK').then(
          () => client.release(),
          (rollbackError: Error) => client.release(rollbackError),
        );
        throw error;
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Connects to Postgres and checks the connection works.
 *
 * Fails fast with a DatabaseConnectionError (original error attached as
 * `cause`) instead of letting the server start against an unreachable database.
 */
export async function openDatabase(options: DatabaseOptions): Promise<Db> {
  const db = createPostgresDb(options);
  try {
    await db.query('SELECT 1');
    return db;
  } catch (error) {
    await db.close().catch(() => {});
    throw new DatabaseConnectionError(
      `Could not connect to the database at ${describeTarget(options.connectionString)}`,
      { cause: error },
    );
  }
}

/**
 * Liveness probe used by the health endpoint. Never throws: returns false if
 * the database is closed or can't be reached.
 */
export async function isDatabaseHealthy(db: Db): Promise<boolean> {
  if (!db.isOpen) return false;
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
