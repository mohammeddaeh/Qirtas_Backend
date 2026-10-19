import * as userRoleAssignmentsRepository from '../../identity/repositories/user-role-assignments.repository.js';
import * as stockRepository from '../../inventory/repositories/stock.repository.js';
import * as productsService from '../../catalog/services/products.service.js';
import * as repo from '../repositories/search.repository.js';

/**
 * «انتقل إلى…» — the records half (docs/reference/global_search.md).
 *
 * One request, up to five hits per kind, **and only the kinds the reader may
 * open**: a kind the reader lacks the key for is `null`, not an empty list —
 * the screen leaves its section out instead of saying «nothing matched» about
 * something it was never allowed to look in. Invoices and print orders come
 * only from the branches where the reader holds the key (user decision
 * 2026-10-18): a cashier of one branch does not find another branch's sales.
 */

export const SEARCH_KEYS = {
  products: 'catalog.view',
  sales: 'sales.view',
  printJobs: 'printing.queue.view',
  customers: 'customers.view',
  users: 'users.view',
} as const;

export interface WireSearchResults {
  products: { id: number; name_ar: string; name_en: string | null; category: string; thumbnail: string | null }[] | null;
  sales: {
    id: number;
    number: string | null;
    customer_name: string | null;
    total_syp: number;
    status: string;
    branch_name: string;
    at: string;
  }[] | null;
  print_jobs: {
    id: number;
    number: string | null;
    pickup_code: string | null;
    name: string | null;
    label: string | null;
    status: string;
    branch_name: string;
  }[] | null;
  customers: { id: number; name: string; phone: string | null; email: string | null; status: string }[] | null;
  users: { id: number; name: string; email: string; phone: string | null; status: string }[] | null;
}

const fullName = (first: string | null, last: string | null): string =>
  [first, last].filter(Boolean).join(' ').trim();

export async function search(actorUserId: number, q: string): Promise<WireSearchResults> {
  const [held, live] = await Promise.all([
    userRoleAssignmentsRepository.findAllEffectivePermissionKeys(actorUserId),
    stockRepository.findLiveBranches(),
  ]);
  const byBranch = await userRoleAssignmentsRepository.findEffectivePermissionKeysByBranch(
    actorUserId,
    live.map((b) => b.id),
  );
  const branchesWith = (key: string): number[] => live.filter((b) => byBranch.get(b.id)?.has(key)).map((b) => b.id);
  const can = (key: string): boolean => held.includes(key);

  const salesBranches = branchesWith(SEARCH_KEYS.sales);
  const jobBranches = branchesWith(SEARCH_KEYS.printJobs);

  const [products, sales, jobs, customers, users] = await Promise.all([
    can(SEARCH_KEYS.products)
      ? productsService.listProducts({ page: 1, limit: 5, offset: 0 }, { search: q, sort_by: 'created_at', sort_dir: 'desc' })
      : null,
    salesBranches.length ? repo.findSales(q, salesBranches) : null,
    jobBranches.length ? repo.findPrintJobs(q, jobBranches) : null,
    can(SEARCH_KEYS.customers) ? repo.findCustomers(q) : null,
    can(SEARCH_KEYS.users) ? repo.findUsers(q) : null,
  ]);

  return {
    products:
      products?.items.map((p) => ({
        id: p.id,
        name_ar: p.name_ar,
        name_en: p.name_en,
        category: p.category.name_ar,
        thumbnail: p.thumbnail?.urls.thumb ?? null,
      })) ?? null,
    sales:
      sales?.map((s) => ({
        id: s.id,
        number: s.number,
        customer_name: s.customer_name,
        total_syp: Number(s.total_syp),
        status: s.status,
        branch_name: s.branch_name,
        at: (s.at ?? s.created_at).toISOString(),
      })) ?? null,
    print_jobs:
      jobs?.map((j) => ({
        id: j.id,
        number: j.number,
        pickup_code: j.pickup_code,
        name: fullName(j.first_name, j.last_name) || j.contact_name,
        label: j.label,
        status: j.status,
        branch_name: j.branch_name,
      })) ?? null,
    customers:
      customers?.map((c) => ({
        id: c.id,
        name: fullName(c.first_name, c.last_name),
        phone: c.phone,
        email: c.email,
        status: c.status,
      })) ?? null,
    users:
      users?.map((u) => ({
        id: u.id,
        name: fullName(u.first_name, u.last_name),
        email: u.email,
        phone: u.phone,
        status: u.status,
      })) ?? null,
  };
}
