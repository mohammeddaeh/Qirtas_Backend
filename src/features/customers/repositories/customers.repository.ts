import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated } from '../../../core/db/crud-helpers.js';
import { likeTerm } from '../../../core/db/like-term.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import type { CustomersFilterQuery } from '../dtos/customers.dto.js';
import * as accountEmails from '../../../core/auth/repositories/account-emails.repository.js';
import * as pushTokens from '../../../core/notifications/repositories/push-tokens.repository.js';
import {
  customerActivityLogTable,
  customersTable,
  type CustomerRow,
  type NewCustomerRow,
} from '../schemas/customers.schema.js';

export type CustomerActivityRow = typeof customerActivityLogTable.$inferSelect;

/** Row access for customers. Lifecycle rules live in `customers.service.ts`; sign-in rules in `account-store.impl.ts`. */

export async function findById(id: number): Promise<CustomerRow | undefined> {
  const rows = await db.select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
  return rows[0];
}

export async function findByEmail(email: string): Promise<CustomerRow | undefined> {
  const rows = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.email, email.toLowerCase()))
    .limit(1);
  return rows[0];
}

/**
 * Inserts the customer and claims the address in `account_emails` in one
 * transaction — a duplicate in EITHER realm (a staff member already holds it)
 * raises `23505` and rolls both back.
 */
export async function insert(data: NewCustomerRow): Promise<CustomerRow> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(customersTable)
      .values({ ...data, email: data.email.toLowerCase() })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    await accountEmails.claim(tx, 'customer', row.email, row.id);
    return row;
  });
}

export async function update(
  id: number,
  data: Partial<NewCustomerRow>,
): Promise<CustomerRow | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(customersTable)
      .set(data.email !== undefined ? { ...data, email: data.email.toLowerCase() } : data)
      .where(eq(customersTable.id, id))
      .returning();
    const row = rows[0];
    if (row && data.email !== undefined) await accountEmails.move(tx, 'customer', id, row.email);
    return row;
  });
}

// ── Admin listing ─────────────────────────────────────────────────────────────

const sortColumns = {
  created_at: customersTable.created_at,
  first_name: customersTable.first_name,
} as const;

/**
 * The customer directory for `GET /customers`. Archived rows are always left
 * out — there is no archive flow yet, and a retired row must never resurface in
 * a list just because nobody wrote the filter for it.
 */
export function findMany(
  params: PaginationParams,
  filter: CustomersFilterQuery,
  /** Whether the caller may search by email/phone — see `applyContactPolicy`. */
  canSearchContact = true,
): Promise<{ rows: CustomerRow[]; total: number }> {
  // Always applied: `archived` picks which set is being browsed, and every
  // other filter narrows inside it (an archived account is `disabled` too, so
  // without this the "disabled" filter would resurface every retired one).
  const conditions: SQL[] = [
    filter.archived === true
      ? sql`${customersTable.archived_at} IS NOT NULL`
      : sql`${customersTable.archived_at} IS NULL`,
  ];
  if (filter.wholesale_status !== undefined) {
    conditions.push(eq(customersTable.wholesale_status, filter.wholesale_status));
  }

  if (filter.status !== undefined) conditions.push(eq(customersTable.status, filter.status));
  if (filter.customer_type !== undefined) {
    conditions.push(eq(customersTable.customer_type, filter.customer_type));
  }
  if (filter.email_verified !== undefined) {
    conditions.push(
      filter.email_verified
        ? sql`${customersTable.email_verified_at} IS NOT NULL`
        : sql`${customersTable.email_verified_at} IS NULL`,
    );
  }
  if (filter.search !== undefined && filter.search.length > 0) {
    // First + last matched as one string, so "ليلى حداد" finds a person whose
    // names are stored in two columns.
    const term = likeTerm(filter.search);
    // A search that reaches email/phone is an oracle for the very data the
    // response masks: type "0933111" and the rows that come back reveal whose
    // number it is. So it only reaches them for someone allowed to read them.
    const name = sql`${customersTable.first_name} || ' ' || ${customersTable.last_name} ILIKE ${term}`;
    conditions.push(
      canSearchContact
        ? sql`(${name} OR ${customersTable.email} ILIKE ${term} OR ${customersTable.phone} ILIKE ${term})`
        : sql`(${name})`,
    );
  }

  const orderFn = filter.sort_dir === 'asc' ? asc : desc;
  return findManyPaginated<CustomerRow>(customersTable, params, {
    where: and(...conditions),
    orderBy: orderFn(sortColumns[filter.sort_by]),
  });
}

// ── Lifecycle & activity ──────────────────────────────────────────────────────

/**
 * Destroys the row and its email claim in one transaction.
 *
 * Sessions and verification codes go with it (`ON DELETE CASCADE`), push
 * tokens explicitly (no FK to cascade from); activity
 * rows survive with `customer_id` nulled, so "someone tried to sign in as X"
 * stays findable after X is gone. Reachable only after the service has checked
 * the account is disabled — and, once orders exist, that nothing points at it.
 */
export async function remove(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(customersTable).where(eq(customersTable.id, id));
    await accountEmails.release(tx, 'customer', id);
    await pushTokens.removeAllForAccount(tx, 'customer', id);
  });
}

export async function findActivity(
  customerId: number,
  params: PaginationParams,
): Promise<{ rows: CustomerActivityRow[]; total: number }> {
  return findManyPaginated<CustomerActivityRow>(customerActivityLogTable, params, {
    where: eq(customerActivityLogTable.customer_id, customerId),
    orderBy: desc(customerActivityLogTable.created_at),
  });
}

/** Customer-initiated events (wholesale request…) go to the customer's own log, never to the staff audit log. */
export async function logActivity(entry: {
  customerId: number;
  action: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
  deviceInfo?: string | null;
}): Promise<void> {
  await db.insert(customerActivityLogTable).values({
    customer_id: entry.customerId,
    action: entry.action,
    details: entry.details ? JSON.stringify(entry.details) : null,
    ip_address: entry.ipAddress ?? null,
    device_info: entry.deviceInfo ?? null,
  });
}
