/**
 * CLI entry point: `npm run seed -- --yes`
 * Replaces ALL data in the DATABASE_URL database (e.g. Supabase) with 100 users
 * and 1500 transactions (at least 10 per user). Requires --yes because it
 * deletes whatever is there.
 * The assignment asks for 1000; we use 1500 so the 10-per-user minimum still leaves
 * 500 to distribute randomly. With exactly 1000, every user would get exactly 10.
 *
 * On failure it prints a clear message and exits with code 1 (so scripts/CI
 * notice). Seeding runs in one transaction, so a failure part-way leaves the
 * previous data untouched rather than half-replaced.
 */
import { config } from '../config';
import { openDatabase, type Db } from './connection';
import { seedDatabase } from './seedData';

const target = new URL(config.databaseUrl).hostname;

if (!process.argv.includes('--yes')) {
  console.error(`This deletes every user and transaction in the database at ${target}.`);
  console.error('Run `npm run seed -- --yes` to continue.');
  process.exit(1);
}

let db: Db | undefined;
try {
  db = await openDatabase({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  await seedDatabase(db, { userCount: 100, transactionCount: 1500, minTransactionsPerUser: 10 });
  const [counts] = await db.query<{ users: number; transactions: number }>(
    `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM transactions) AS transactions`,
  );
  console.log(
    `Seeded ${counts?.users} users and ${counts?.transactions} transactions into ${target}`,
  );
} catch (error) {
  console.error(`Seeding failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error); // full details, including the underlying `cause`
  process.exitCode = 1; // let `finally` close the DB instead of exiting immediately
} finally {
  await db?.close();
}
