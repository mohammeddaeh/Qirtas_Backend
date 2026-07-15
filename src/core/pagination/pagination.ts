import { z } from 'zod';

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

/**
 * Query params sent by the Flutter app's PaginationQuery.toJson(): `page`
 * (default 1) and `limit` (default 15, wire name for Dart's `perPage`).
 * See docs/rest_api.md.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(15),
});

export function toPaginationParams(query: { page: number; limit: number }): PaginationParams {
  return {
    page: query.page,
    limit: query.limit,
    offset: (query.page - 1) * query.limit,
  };
}

/**
 * The paginated list response shape. This is a NEW contract (no equivalent
 * exists in working Flutter code yet — see docs/rest_api.md for why `items`
 * + `total_pages` was chosen as the reference shape for both sides).
 */
export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export function paginated<T>(items: T[], total: number, params: PaginationParams): Paginated<T> {
  return {
    items,
    page: params.page,
    limit: params.limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / params.limit)),
  };
}
