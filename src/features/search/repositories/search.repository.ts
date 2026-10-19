import { and, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { likeTerm } from '../../../core/db/like-term.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { customersTable } from '../../customers/schemas/customers.schema.js';
import { salesTable } from '../../sales/schemas/sales.schema.js';
import { printJobsTable } from '../../printing/schemas/print-jobs.schema.js';

/**
 * The record half of «انتقل إلى…» (docs/reference/global_search.md). Each
 * reader returns at most [limit] rows, newest first, and only from the
 * branches it is given — the service decides which those are.
 */

const PER_KIND = 5;

/** Posted or voided invoices — open and held baskets live at the till. */
export async function findSales(term: string, branchIds: number[] | 'all', limit = PER_KIND) {
  const like = likeTerm(term);
  return db
    .select({
      id: salesTable.id,
      number: salesTable.number,
      customer_name: salesTable.customer_name,
      total_syp: salesTable.total_syp,
      status: salesTable.status,
      branch_name: branchesTable.name,
      at: salesTable.paid_at,
      created_at: salesTable.created_at,
    })
    .from(salesTable)
    .innerJoin(branchesTable, eq(branchesTable.id, salesTable.branch_id))
    .where(
      and(
        inArray(salesTable.status, ['paid', 'void']),
        branchIds === 'all' ? undefined : inArray(salesTable.branch_id, branchIds.length ? branchIds : [-1]),
        or(ilike(salesTable.number, like), ilike(salesTable.customer_name, like)),
      ),
    )
    .orderBy(desc(salesTable.created_at))
    .limit(limit);
}

export async function findPrintJobs(term: string, branchIds: number[] | 'all', limit = PER_KIND) {
  const like = likeTerm(term);
  const upper = term.toUpperCase();
  return db
    .select({
      id: printJobsTable.id,
      number: printJobsTable.number,
      pickup_code: printJobsTable.pickup_code,
      contact_name: printJobsTable.contact_name,
      first_name: customersTable.first_name,
      last_name: customersTable.last_name,
      label: printJobsTable.label,
      status: printJobsTable.status,
      branch_name: branchesTable.name,
      created_at: printJobsTable.created_at,
    })
    .from(printJobsTable)
    .innerJoin(branchesTable, eq(branchesTable.id, printJobsTable.branch_id))
    .leftJoin(customersTable, eq(customersTable.id, printJobsTable.customer_id))
    .where(
      and(
        ne(printJobsTable.status, 'draft'),
        branchIds === 'all' ? undefined : inArray(printJobsTable.branch_id, branchIds.length ? branchIds : [-1]),
        sql`(upper(${printJobsTable.pickup_code}) = ${upper}
          OR ${printJobsTable.number} ILIKE ${like}
          OR ${printJobsTable.contact_name} ILIKE ${like}
          OR ${printJobsTable.contact_phone} ILIKE ${like}
          OR ${printJobsTable.label} ILIKE ${like}
          OR ${customersTable.phone} ILIKE ${like}
          OR (${customersTable.first_name} || ' ' || ${customersTable.last_name}) ILIKE ${like})`,
      ),
    )
    .orderBy(desc(printJobsTable.created_at))
    .limit(limit);
}

export async function findCustomers(term: string, limit = PER_KIND) {
  const like = likeTerm(term);
  return db
    .select({
      id: customersTable.id,
      first_name: customersTable.first_name,
      last_name: customersTable.last_name,
      phone: customersTable.phone,
      email: customersTable.email,
      status: customersTable.status,
    })
    .from(customersTable)
    .where(
      and(
        isNull(customersTable.archived_at),
        sql`((${customersTable.first_name} || ' ' || coalesce(${customersTable.last_name}, '')) ILIKE ${like}
          OR ${customersTable.phone} ILIKE ${like}
          OR ${customersTable.email} ILIKE ${like})`,
      ),
    )
    .orderBy(desc(customersTable.created_at))
    .limit(limit);
}

export async function findUsers(term: string, limit = PER_KIND) {
  const like = likeTerm(term);
  return db
    .select({
      id: usersTable.id,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      email: usersTable.email,
      phone: usersTable.phone,
      status: usersTable.status,
    })
    .from(usersTable)
    .where(
      and(
        isNull(usersTable.archived_at),
        sql`((${usersTable.first_name} || ' ' || ${usersTable.last_name}) ILIKE ${like}
          OR ${usersTable.email} ILIKE ${like}
          OR ${usersTable.phone} ILIKE ${like})`,
      ),
    )
    .orderBy(desc(usersTable.created_at))
    .limit(limit);
}
