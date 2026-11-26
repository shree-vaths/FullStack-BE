import cors from 'cors';
import express, { type Express } from 'express';
import { isDatabaseHealthy, type Db } from './db/connection';
import { DB_RETRY_AFTER_SECONDS } from './errors/AppError';
import type { ApiError } from './types';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createTransactionRepository } from './repositories/transactionRepository';
import { createUserRepository } from './repositories/userRepository';
import { createUserRouter } from './routes/userRoutes';
import { createUserService } from './services/userService';

export interface AppOptions {
  /**
   * Browser origins allowed to call the API cross-origin (CORS), e.g.
   * ["https://fullstack-fe.onrender.com"]. Empty = same-origin only.
   */
  corsOrigins?: string[];
}

/**
 * Composition root: builds the app by wiring db -> repositories -> services -> routes.
 *
 * The database and options are passed in rather than imported, so tests can
 * hand in an in-process Postgres (PGlite) and their own CORS list, and building
 * the app never has side effects like opening a port.
 */
export function createApp(db: Db, options: AppOptions = {}): Express {
  const userService = createUserService({
    users: createUserRepository(db),
    transactions: createTransactionRepository(db),
  });

  const app = express();
  app.disable('x-powered-by'); // don't advertise the framework to clients

  // CORS: lets the deployed frontend (a different origin) call this API from
  // the browser. Registered first so it also covers errors and 404s; otherwise
  // the browser would hide those responses and report a CORS failure instead.
  // A request from an origin not on the list gets no CORS headers, so the
  // browser blocks it. (CORS only restricts browsers; it is not
  // authentication: curl and servers can still call the API.)
  app.use(
    cors({
      origin: options.corsOrigins ?? [],
      methods: ['GET'], // the API is read-only
      // Cross-origin JS can only read "simple" response headers unless they are
      // exposed; the client's retry logic needs Retry-After on 503s.
      exposedHeaders: ['Retry-After'],
      maxAge: 600, // let browsers cache the preflight answer for 10 minutes
    }),
  );

  // Reports whether the app can actually reach its database, so a load
  // balancer / uptime check can take an unhealthy instance out of rotation.
  app.get('/api/health', async (_req, res) => {
    if (await isDatabaseHealthy(db)) {
      res.json({ data: { status: 'ok', database: 'ok' } });
      return;
    }
    const body: ApiError = {
      error: { code: 'DATABASE_UNAVAILABLE', message: 'Database is not reachable' },
    };
    res.status(503).set('Retry-After', String(DB_RETRY_AFTER_SECONDS)).json(body);
  });
  app.use('/api/users', createUserRouter(userService));

  // Must be registered after all routes.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
