import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDatabase } from '../src/db/seedData';
import { createTestDb, resetSchema, type TestDb } from './testDb';

describe('seedDatabase', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  beforeEach(() => resetSchema(db));
  afterAll(() => db.close());

  const transactionCountsPerUser = async () =>
    (
      await db.query<{ count: number }>(
        `SELECT COUNT(t.id) AS count
           FROM users u LEFT JOIN transactions t ON t.user_id = u.id
          GROUP BY u.id`,
      )
    ).map((row) => row.count);

  it('creates the requested number of users and transactions', async () => {
    await seedDatabase(db, { userCount: 10, transactionCount: 120, minTransactionsPerUser: 5 });

    const counts = await transactionCountsPerUser();
    expect(counts).toHaveLength(10);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(120);
  });

  it('gives every user at least the minimum number of transactions', async () => {
    await seedDatabase(db, { userCount: 10, transactionCount: 120, minTransactionsPerUser: 5 });

    expect(Math.min(...(await transactionCountsPerUser()))).toBeGreaterThanOrEqual(5);
  });

  it('rejects a minimum that the total cannot satisfy, without writing anything', async () => {
    await expect(
      seedDatabase(db, { userCount: 10, transactionCount: 40, minTransactionsPerUser: 5 }),
    ).rejects.toThrow(/at least 5 transactions/);
    expect(await transactionCountsPerUser()).toHaveLength(0);
  });

  it('replaces existing data and restarts ids at 1', async () => {
    await seedDatabase(db, { userCount: 10, transactionCount: 120 });
    await seedDatabase(db, { userCount: 4, transactionCount: 20 });

    const users = await db.query<{ id: number }>(`SELECT id FROM users ORDER BY id`);
    expect(users.map((u) => u.id)).toEqual([1, 2, 3, 4]);
  });

  it('never dates a transaction before the user registered', async () => {
    await seedDatabase(db, { userCount: 10, transactionCount: 120, minTransactionsPerUser: 5 });

    const [violations] = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM transactions t JOIN users u ON u.id = t.user_id
        WHERE t.service_date < u.registration_date`,
    );
    expect(violations?.n).toBe(0);
  });
});
