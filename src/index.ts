/**
 * Process entry point: connects to the DB, starts the HTTP server, and shuts down cleanly.
 * Kept separate from app.ts so the app can be tested without listening on a port.
 *
 * Startup is fail-fast: if the database can't be reached or the port can't be
 * bound, log one clear message and exit with code 1, rather than running in a
 * half-working state.
 */
import http from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { openDatabase, type Db } from './db/connection';

/** Max time to wait for in-flight requests on shutdown before forcing exit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function fail(message: string, error: unknown): never {
  console.error(`Fatal: ${message}`);
  console.error(error); // includes the `cause` chain, e.g. the underlying Postgres error
  process.exit(1);
}

async function warnIfEmpty(db: Db): Promise<void> {
  const [row] = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM users`);
  if (!row?.n)
    console.warn(
      'Warning: the database has no users. Run `npm run seed -- --yes` to add sample data.',
    );
}

async function start(): Promise<void> {
  let db: Db;
  let server: http.Server;
  try {
    db = await openDatabase({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
    // Also confirms the tables exist (see supabase/supabase_setup.sql).
    await warnIfEmpty(db);
    server = http.createServer(createApp(db, { corsOrigins: config.corsOrigins }));
    console.log(
      `CORS allowed origins: ${config.corsOrigins.join(', ') || '(none: same-origin only)'}`,
    );
  } catch (error) {
    fail('could not initialise the database or the app', error);
  }

  // Binding errors (port in use, no permission) arrive as an event, not a throw.
  server.on('error', (error: NodeJS.ErrnoException) => {
    void db.close();
    const reason =
      error.code === 'EADDRINUSE'
        ? `port ${config.port} is already in use (set PORT to use another)`
        : `could not start the HTTP server on port ${config.port}`;
    fail(reason, error);
  });

  server.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port}`);
  });

  // Finish in-flight requests, then close the DB pool on Ctrl+C / container stop.
  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return; // a second Ctrl+C shouldn't start a second shutdown
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);

    // Safety net: keep-alive connections can hold server.close() open forever.
    setTimeout(() => {
      console.error('Shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    server.close(async (closeError) => {
      let exitCode = closeError ? 1 : 0;
      if (closeError) console.error('Error while closing the HTTP server:', closeError);
      try {
        await db.close();
      } catch (error) {
        console.error('Error while closing the database:', error);
        exitCode = 1;
      }
      process.exit(exitCode);
    });
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void start();
