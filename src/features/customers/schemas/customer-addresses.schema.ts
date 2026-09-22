import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  timestamp,
  boolean,
  numeric,
  pgEnum,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customersTable } from './customers.schema.js';

/**
 * What the place is to the customer. An enum and not free text so the app can
 * show it in the reader's language; `label` carries a custom name on top
 * ("بيت أهلي") when the three are not enough.
 */
export const addressKindEnum = pgEnum('address_kind', ['home', 'work', 'other']);

/**
 * Where a customer wants things delivered — several places, exactly one default.
 *
 * Replaces the single `customers.address` text column (migration 0018 copied
 * every non-empty value into a default row here, then dropped the column). One
 * text field could not say "deliver to my office this time" without overwriting
 * home.
 *
 * **An order will copy the address, not point at it.** Editing or deleting a
 * row here must never move where an old order was delivered, so there is no FK
 * from orders to this table by design — which is also why rows are deleted
 * outright rather than archived.
 */
export const customerAddressesTable = pgTable(
  'customer_addresses',
  {
    id: serial('id').primaryKey(),
    /** `cascade`: an erased customer's addresses are personal data and go with them. */
    customer_id: integer('customer_id')
      .notNull()
      .references(() => customersTable.id, { onDelete: 'cascade' }),
    kind: addressKindEnum('kind').notNull().default('home'),
    /** Optional custom name shown instead of the kind. */
    label: varchar('label', { length: 50 }),
    /** For delivering to someone else. Null → the account holder. */
    recipient_name: varchar('recipient_name', { length: 200 }),
    /** Null → the account's own phone. */
    recipient_phone: varchar('recipient_phone', { length: 32 }),
    /**
     * City / neighbourhood. Empty only on rows migrated from the old free-text
     * column, which had no such split — the API requires it on every write.
     */
    area: varchar('area', { length: 200 }).notNull().default(''),
    /** Street, building, floor — the text a courier actually follows. */
    details: text('details').notNull(),
    landmark: varchar('landmark', { length: 255 }),
    /** Optional map pin. Text stays required: many addresses here are found by landmark, not coordinates. */
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    is_default: boolean('is_default').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('customer_addresses_customer_idx').on(t.customer_id),
    // At most one default per customer, held by the database: two concurrent
    // "make default" calls cannot both win.
    uniqueIndex('customer_addresses_one_default_uq')
      .on(t.customer_id)
      .where(sql`${t.is_default}`),
    // Same rule as `branches`: both halves of a pin or neither.
    check(
      'customer_addresses_coords_chk',
      sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL) AND (${t.latitude} IS NULL OR (${t.latitude} BETWEEN -90 AND 90 AND ${t.longitude} BETWEEN -180 AND 180))`,
    ),
  ],
);

export type CustomerAddressRow = typeof customerAddressesTable.$inferSelect;
export type NewCustomerAddressRow = typeof customerAddressesTable.$inferInsert;
