import type { SortOrder } from '../types';

/** Small SQL utilities shared by the repositories. */

/**
 * Builds an ORDER BY clause from an allow-list of sortable columns.
 *
 * ORDER BY can't use bound parameters, so `columns` (fixed strings written by
 * us) is the only thing ever interpolated; user input just picks a key.
 * `id` is appended as a tie-breaker so the order is deterministic and rows with
 * equal values never repeat or go missing between pages.
 */
export function orderByClause<Field extends string>(
  columns: Record<Field, string>,
  sortBy: Field,
  sortOrder: SortOrder,
): string {
  const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${columns[sortBy]} ${direction}, id ${direction}`;
}
