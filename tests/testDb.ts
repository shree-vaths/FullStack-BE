import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, types } from '@electric-sql/pglite';
import type { Db, Queryable } from '../src/db/connection';

/**
 * A real Postgres for tests, running in-process (PGlite, Postgres compiled to
 * WebAssembly): no server or network needed, and the tests exercise the same
 * SQL that runs against Supabase.
 */

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql');
const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');

/** Same type handling as the production driver (see src/db/connection.ts). */
const parsers = {
  [types.INT8]: (value: string) => Number(value),
  [types.DATE]: (value: string) => value,
};

/** The app's Db plus `exec` for multi-statement SQL scripts (tests only). */
export interface TestDb extends Db {
  exec(sql: string): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite({ parsers });
  await pglite.exec(schemaSql);

  const wrap = (q: Pick<PGlite, 'query'>): Queryable => ({
    query: async <Row extends object>(sql: string, params?: unknown[]) =>
      (await q.query<Row>(sql, params)).rows,
  });

  return {
    get isOpen() {
      return !pglite.closed;
    },
    ...wrap(pglite),
    transaction: (fn, options) =>
      pglite.transaction(async (tx) => {
        if (options?.readOnly) {
          await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        }
        return fn(wrap(tx));
      }),
    close: () => pglite.close(),
    exec: async (sql) => {
      await pglite.exec(sql);
    },
  };
}

/** Drops and recreates the tables, so one database can be reused across tests. */
export async function resetSchema(db: TestDb): Promise<void> {
  await db.exec(`DROP TABLE IF EXISTS transactions, users; ${schemaSql}`);
}
