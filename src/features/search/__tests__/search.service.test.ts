import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../identity/repositories/user-role-assignments.repository.js', () => ({
  findAllEffectivePermissionKeys: vi.fn(),
  findEffectivePermissionKeysByBranch: vi.fn(),
}));
vi.mock('../../inventory/repositories/stock.repository.js', () => ({
  findLiveBranches: vi.fn(async () => [
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
  ]),
}));
vi.mock('../../catalog/services/products.service.js', () => ({ listProducts: vi.fn(async () => ({ items: [] })) }));
vi.mock('../repositories/search.repository.js', () => ({
  findSales: vi.fn(async () => []),
  findPrintJobs: vi.fn(async () => []),
  findCustomers: vi.fn(async () => []),
  findUsers: vi.fn(async () => []),
}));

import * as assignments from '../../identity/repositories/user-role-assignments.repository.js';
import * as repo from '../repositories/search.repository.js';
import { search } from '../services/search.service.js';

/**
 * A search that answers from somewhere the reader may not look is silent: the
 * hit simply appears. So each gate is pinned with its opposite — a kind
 * without its key is `null` **and** a held key searches; a branch-scoped key
 * searches **only** its branches.
 */
describe('search scope', () => {
  beforeEach(() => vi.clearAllMocks());

  function holds(all: string[], byBranch: Record<number, string[]>) {
    vi.mocked(assignments.findAllEffectivePermissionKeys).mockResolvedValue(all);
    vi.mocked(assignments.findEffectivePermissionKeysByBranch).mockResolvedValue(
      new Map(Object.entries(byBranch).map(([k, v]) => [Number(k), new Set(v)])),
    );
  }

  it('a kind without its key is null — never searched', async () => {
    holds(['catalog.view'], { 1: ['catalog.view'], 2: ['catalog.view'] });
    const r = await search(7, 'ab');
    expect(r.products).toEqual([]);
    expect(r.sales).toBeNull();
    expect(r.print_jobs).toBeNull();
    expect(r.customers).toBeNull();
    expect(r.users).toBeNull();
    expect(repo.findSales).not.toHaveBeenCalled();
    expect(repo.findUsers).not.toHaveBeenCalled();
  });

  it('invoices come only from the branches where the reader holds sales.view', async () => {
    holds(['sales.view'], { 1: [], 2: ['sales.view'] });
    const r = await search(7, 'ab');
    expect(r.sales).toEqual([]);
    expect(repo.findSales).toHaveBeenCalledWith('ab', [2]);
  });

  it('…and print orders likewise, by their own key', async () => {
    holds(['printing.queue.view'], { 1: ['printing.queue.view'], 2: [] });
    await search(7, 'ab');
    expect(repo.findPrintJobs).toHaveBeenCalledWith('ab', [1]);
    expect(repo.findSales).not.toHaveBeenCalled();
  });

  it('customers and staff follow their keys', async () => {
    holds(['customers.view', 'users.view'], { 1: [], 2: [] });
    const r = await search(7, 'ab');
    expect(r.customers).toEqual([]);
    expect(r.users).toEqual([]);
    expect(r.products).toBeNull();
  });
});
