import { Router } from 'express';
import {
  TRANSACTION_SORT_FIELDS,
  USER_SORT_FIELDS,
  type ApiPage,
  type ApiSuccess,
  type Transaction,
  type User,
} from '../types';
import type { Page } from '../pagination';
import type { UserService } from '../services/userService';
import { idParamSchema, listQuerySchema, parseOrThrow } from './validation';

/**
 * HTTP layer for /api/users. Its only jobs: validate input, call the service,
 * shape the response. No SQL and no business rules live here.
 */

// Defaults are part of the API contract: users in insertion order,
// transactions newest first.
const usersQuery = listQuerySchema(USER_SORT_FIELDS, { sortBy: 'id', sortOrder: 'asc' });
const transactionsQuery = listQuerySchema(TRANSACTION_SORT_FIELDS, {
  sortBy: 'serviceDate',
  sortOrder: 'desc',
});

const toApiPage = <T>(page: Page<T>): ApiPage<T> => ({
  data: page.items,
  pagination: page.pageInfo,
});

export function createUserRouter(userService: UserService): Router {
  const router = Router();

  // GET /api/users?page=&pageSize=&sortBy=id|name|registrationDate&sortOrder=asc|desc
  router.get('/', async (req, res) => {
    const query = parseOrThrow(usersQuery, req.query);
    const body: ApiPage<User> = toApiPage(await userService.listUsers(query));
    res.json(body);
  });

  router.get('/:id', async (req, res) => {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body: ApiSuccess<User> = { data: await userService.getUser(id) };
    res.json(body);
  });

  // GET /api/users/:id/transactions?page=&pageSize=&sortBy=id|serviceDate|priceCents&sortOrder=asc|desc
  router.get('/:id/transactions', async (req, res) => {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const query = parseOrThrow(transactionsQuery, req.query);
    const body: ApiPage<Transaction> = toApiPage(
      await userService.listTransactionsForUser(id, query),
    );
    res.json(body);
  });

  return router;
}
