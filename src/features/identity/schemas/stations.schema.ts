import { boolean, index, integer, pgTable, serial, timestamp, varchar } from 'drizzle-orm/pg-core';
import { branchesTable } from './branches.schema.js';
import { usersTable } from './users.schema.js';

/**
 * **The shop's registered computers** (`docs/reference/stations.md`, phase 2).
 *
 * Phase 1 trusted the client to say it was a computer; a station is a computer
 * the administration registered from inside, on that computer, so the server knows it. One branch per
 * station — the till on it opens there.
 */
export const stationsTable = pgTable(
  'stations',
  {
    id: serial('id').primaryKey(),
    branch_id: integer('branch_id')
      .notNull()
      .references(() => branchesTable.id, { onDelete: 'restrict' }),
    /** «الصندوق ١», «محطة الطباعة» — unique among the branch's live stations. */
    name: varchar('name', { length: 80 }).notNull(),
    /**
     * What the computer is for — and so who signs in on it (user decision
     * 2026-10-11, by permission, never by role name): `till` needs `sales.sell`,
     * `printing` needs `printing.queue.view`, `office` needs `dashboard.view`.
     */
    kind: varchar('kind', { length: 16 }).notNull().default('till'),
    /** SHA-256 of the station token; the token itself is never kept (as sessions). */
    token_hash: varchar('token_hash', { length: 64 }).notNull().unique(),
    registered_by: integer('registered_by').references(() => usersTable.id, { onDelete: 'set null' }),
    registered_at: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    /** Written at most once a minute from requests carrying the token. */
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }),
    device_info: varchar('device_info', { length: 300 }),
    /** `null` = live. A revoked station's token reads as no station at all. */
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    revoked_by: integer('revoked_by').references(() => usersTable.id, { onDelete: 'set null' }),
  },
  (t) => ({
    branchIdx: index('stations_branch_idx').on(t.branch_id),
  }),
);

/**
 * One row: whether staff sign-in from a computer needs a registered station.
 * **Off by default** (user decision 2026-10-11): turning it on before the
 * shop's computers are paired would lock every one of them out at once.
 */
export const stationPolicyTable = pgTable('station_policy', {
  id: integer('id').primaryKey().default(1),
  enforce: boolean('enforce').notNull().default(false),
  updated_by: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type StationRow = typeof stationsTable.$inferSelect;
