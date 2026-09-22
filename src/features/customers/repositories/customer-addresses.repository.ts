import { and, count, desc, eq, ne } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { customersTable } from '../schemas/customers.schema.js';
import {
  customerAddressesTable,
  type CustomerAddressRow,
  type NewCustomerAddressRow,
} from '../schemas/customer-addresses.schema.js';

/**
 * Row access for a customer's addresses. Every query is scoped by
 * `customer_id`: an id belonging to someone else reads exactly like one that
 * does not exist.
 *
 * Writes run in a transaction that first locks the customer row. That is what
 * makes "the first address becomes the default" and the address cap hold under
 * two simultaneous requests — without it both would count zero and both would
 * claim the default (the unique index would then reject one as a 500).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockCustomer(tx: Tx, customerId: number): Promise<void> {
  await tx
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, customerId))
    .for('update');
}

/** Default first, then most recently touched — the order the checkout picker shows. */
export async function listFor(customerId: number, tx: Tx | typeof db = db): Promise<CustomerAddressRow[]> {
  return tx
    .select()
    .from(customerAddressesTable)
    .where(eq(customerAddressesTable.customer_id, customerId))
    .orderBy(desc(customerAddressesTable.is_default), desc(customerAddressesTable.updated_at));
}

async function findOwned(
  tx: Tx,
  customerId: number,
  addressId: number,
): Promise<CustomerAddressRow | undefined> {
  const rows = await tx
    .select()
    .from(customerAddressesTable)
    .where(
      and(
        eq(customerAddressesTable.id, addressId),
        eq(customerAddressesTable.customer_id, customerId),
      ),
    )
    .limit(1);
  return rows[0];
}

async function clearDefault(tx: Tx, customerId: number): Promise<void> {
  await tx
    .update(customerAddressesTable)
    .set({ is_default: false })
    .where(
      and(
        eq(customerAddressesTable.customer_id, customerId),
        eq(customerAddressesTable.is_default, true),
      ),
    );
}

export type CreateOutcome = { kind: 'created'; rows: CustomerAddressRow[] } | { kind: 'limit' };

export async function create(
  customerId: number,
  data: Omit<NewCustomerAddressRow, 'customer_id' | 'is_default'>,
  makeDefault: boolean,
  limit: number,
): Promise<CreateOutcome> {
  return db.transaction(async (tx) => {
    await lockCustomer(tx, customerId);
    const [counted] = await tx
      .select({ n: count() })
      .from(customerAddressesTable)
      .where(eq(customerAddressesTable.customer_id, customerId));
    const existing = counted?.n ?? 0;
    if (existing >= limit) return { kind: 'limit' as const };

    const isDefault = makeDefault || existing === 0;
    if (isDefault) await clearDefault(tx, customerId);
    await tx
      .insert(customerAddressesTable)
      .values({ ...data, customer_id: customerId, is_default: isDefault });
    return { kind: 'created' as const, rows: await listFor(customerId, tx) };
  });
}

/** Null when the address is not this customer's. */
export async function update(
  customerId: number,
  addressId: number,
  data: Partial<Omit<NewCustomerAddressRow, 'customer_id' | 'is_default'>>,
): Promise<CustomerAddressRow[] | null> {
  return db.transaction(async (tx) => {
    await lockCustomer(tx, customerId);
    if (!(await findOwned(tx, customerId, addressId))) return null;
    await tx
      .update(customerAddressesTable)
      .set({ ...data, updated_at: new Date() })
      .where(eq(customerAddressesTable.id, addressId));
    return listFor(customerId, tx);
  });
}

export async function makeDefault(
  customerId: number,
  addressId: number,
): Promise<CustomerAddressRow[] | null> {
  return db.transaction(async (tx) => {
    await lockCustomer(tx, customerId);
    if (!(await findOwned(tx, customerId, addressId))) return null;
    await clearDefault(tx, customerId);
    await tx
      .update(customerAddressesTable)
      .set({ is_default: true })
      .where(eq(customerAddressesTable.id, addressId));
    return listFor(customerId, tx);
  });
}

/**
 * Deleting the default hands it to the most recently touched remaining address.
 * The alternative — addresses but no default — would reach checkout with nothing
 * preselected, and "which one is my main address?" would have no answer.
 */
export async function remove(
  customerId: number,
  addressId: number,
): Promise<CustomerAddressRow[] | null> {
  return db.transaction(async (tx) => {
    await lockCustomer(tx, customerId);
    const row = await findOwned(tx, customerId, addressId);
    if (!row) return null;
    await tx.delete(customerAddressesTable).where(eq(customerAddressesTable.id, addressId));

    if (row.is_default) {
      const [next] = await tx
        .select({ id: customerAddressesTable.id })
        .from(customerAddressesTable)
        .where(
          and(
            eq(customerAddressesTable.customer_id, customerId),
            ne(customerAddressesTable.id, addressId),
          ),
        )
        .orderBy(desc(customerAddressesTable.updated_at))
        .limit(1);
      if (next) {
        await tx
          .update(customerAddressesTable)
          .set({ is_default: true })
          .where(eq(customerAddressesTable.id, next.id));
      }
    }
    return listFor(customerId, tx);
  });
}
