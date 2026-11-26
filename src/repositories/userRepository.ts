import type { ServiceLevel, User, UserSortField } from '../types';
import type { Db } from '../db/connection';
import { withDbErrorHandling } from '../db/dbErrors';
import { toLimitOffset, type ListQuery, type PageResult } from '../pagination';
import { orderByClause } from './sqlHelpers';

/**
 * Data access for users. This is the only place that knows the `users` table
 * layout; everything above it works with the `User` domain type.
 */

/** Row shape exactly as Postgres returns it (snake_case). */
interface UserRow {
  id: number;
  name: string;
  registration_date: string;
  country: string;
  service_level: ServiceLevel;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  registrationDate: row.registration_date,
  country: row.country,
  serviceLevel: row.service_level,
});

const COLUMNS = 'id, name, registration_date, country, service_level';

/** API sort field -> SQL expression (the allow-list used by orderByClause). */
const SORT_COLUMNS: Record<UserSortField, string> = {
  id: 'id',
  name: 'lower(name)', // "alice" and "Bob" sort the way a person expects; matches idx_users_name
  registrationDate: 'registration_date',
};

export interface UserRepository {
  findPage(query: ListQuery<UserSortField>): Promise<PageResult<User>>;
  findById(id: number): Promise<User | undefined>;
}

export function createUserRepository(db: Db): UserRepository {
  // Values are always bound as parameters (never string-concatenated), which
  // prevents SQL injection.

  // Page + count run in one read-only snapshot, so the total always describes
  // the same data as the rows, even if a write lands in between.
  // NOTE: OFFSET gets slower for deep pages of large tables; keyset (cursor)
  // pagination is the scale-up path (Part 3).
  const findPage = (query: ListQuery<UserSortField>): Promise<PageResult<User>> =>
    db.transaction(
      async (tx) => {
        const { limit, offset } = toLimitOffset(query);
        const rows = await tx.query<UserRow>(
          `SELECT ${COLUMNS} FROM users
            ${orderByClause(SORT_COLUMNS, query.sortBy, query.sortOrder)}
            LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        const [count] = await tx.query<{ total: number }>(`SELECT COUNT(*) AS total FROM users`);
        return { items: rows.map(toUser), totalItems: count?.total ?? 0 };
      },
      { readOnly: true },
    );

  const findById = async (id: number): Promise<User | undefined> => {
    const [row] = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return row ? toUser(row) : undefined;
  };

  // Every public method is wrapped, so any database failure reaches callers as
  // a DatabaseError (503 if retryable, else 500) with a client-safe message.
  return {
    findPage: withDbErrorHandling(db, 'list users', findPage),
    findById: withDbErrorHandling(db, 'load the user', findById),
  };
}
