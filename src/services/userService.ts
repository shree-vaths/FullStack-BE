import type { Transaction, TransactionSortField, User, UserSortField } from '../types';
import { NotFoundError } from '../errors/AppError';
import { toPage, type ListQuery, type Page } from '../pagination';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { UserRepository } from '../repositories/userRepository';

/**
 * Use cases for users. This layer holds the rules that are neither HTTP nor SQL,
 * e.g. "asking for a missing user's transactions is an error, not an empty list".
 * It is deliberately thin today; it is where authorization/tenant checks would go.
 */
export interface UserService {
  listUsers(query: ListQuery<UserSortField>): Promise<Page<User>>;
  getUser(id: number): Promise<User>;
  listTransactionsForUser(
    userId: number,
    query: ListQuery<TransactionSortField>,
  ): Promise<Page<Transaction>>;
}

export function createUserService(deps: {
  users: UserRepository;
  transactions: TransactionRepository;
}): UserService {
  const { users, transactions } = deps;

  const getUser = async (id: number): Promise<User> => {
    const user = await users.findById(id);
    if (!user) throw new NotFoundError(`User ${id} not found`);
    return user;
  };

  return {
    listUsers: async (query) => toPage(await users.findPage(query), query),
    getUser,
    listTransactionsForUser: async (userId, query) => {
      // Distinguishes "unknown user" (404) from "user with no transactions" (empty page).
      await getUser(userId);
      return toPage(await transactions.findPageByUserId(userId, query), query);
    },
  };
}
