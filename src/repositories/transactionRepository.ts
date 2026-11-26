import type { Transaction, TransactionSortField } from '../types';
import type { Db } from '../db/connection';
import { withDbErrorHandling } from '../db/dbErrors';
import { toLimitOffset, type ListQuery, type PageResult } from '../pagination';
import { orderByClause } from './sqlHelpers';

/** Data access for transactions. Mirrors userRepository's structure. */

interface TransactionRow {
  id: number;
  user_id: number;
  service_id: number;
  price_cents: number;
  service_date: string;
}

const toTransaction = (row: TransactionRow): Transaction => ({
  id: row.id,
  userId: row.user_id,
  serviceId: row.service_id,
  priceCents: row.price_cents,
  serviceDate: row.service_date,
});

const COLUMNS = 'id, user_id, service_id, price_cents, service_date';

/** API sort field -> SQL expression (the allow-list used by orderByClause). */
const SORT_COLUMNS: Record<TransactionSortField, string> = {
  id: 'id',
  serviceDate: 'service_date',
  priceCents: 'price_cents',
};

export interface TransactionRepository {
  findPageByUserId(
    userId: number,
    query: ListQuery<TransactionSortField>,
  ): Promise<PageResult<Transaction>>;
}

export function createTransactionRepository(db: Db): TransactionRepository {
  // Same pattern as userRepository.findPage: rows + total in one snapshot.
  // Both queries filter on user_id and use idx_transactions_user_id_service_date.
  const findPageByUserId = (
    userId: number,
    query: ListQuery<TransactionSortField>,
  ): Promise<PageResult<Transaction>> =>
    db.transaction(
      async (tx) => {
        const { limit, offset } = toLimitOffset(query);
        const rows = await tx.query<TransactionRow>(
          `SELECT ${COLUMNS} FROM transactions
            WHERE user_id = $1
            ${orderByClause(SORT_COLUMNS, query.sortBy, query.sortOrder)}
            LIMIT $2 OFFSET $3`,
          [userId, limit, offset],
        );
        const [count] = await tx.query<{ total: number }>(
          `SELECT COUNT(*) AS total FROM transactions WHERE user_id = $1`,
          [userId],
        );
        return { items: rows.map(toTransaction), totalItems: count?.total ?? 0 };
      },
      { readOnly: true },
    );

  return {
    findPageByUserId: withDbErrorHandling(db, 'list transactions', findPageByUserId),
  };
}
