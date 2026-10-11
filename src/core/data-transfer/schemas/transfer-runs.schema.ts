import { pgTable, serial, varchar, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../../../features/identity/schemas/users.schema.js';
import { stationsTable } from '../../../features/identity/schemas/stations.schema.js';

/**
 * **Who moved which data in or out, and when** (2026-10-11, app_structure.md
 * slice ج).
 *
 * Exports carry the shop's records out of the system (customers and prices
 * are next), and imports write many rows at once — neither left any trace
 * before this table. One row per export, and one per import **commit**; the
 * validate phase writes nothing, because it changes nothing.
 *
 * The person and the station are kept as references that survive their
 * deletion (`set null`): the run happened whether or not the account still
 * exists.
 */
export const transferRunsTable = pgTable(
  'data_transfer_runs',
  {
    id: serial('id').primaryKey(),

    /** The registered resource name (`branches`, `products`, …). */
    resource: varchar('resource', { length: 64 }).notNull(),

    /** `export` | `import`. */
    kind: varchar('kind', { length: 10 }).notNull(),

    user_id: integer('user_id').references(() => usersTable.id, { onDelete: 'set null' }),

    station_id: integer('station_id').references(() => stationsTable.id, { onDelete: 'set null' }),

    /** The file the user picked (import) or downloaded (export). Null for an import re-checked from the app's grid without a file. */
    file_name: varchar('file_name', { length: 200 }),

    /** `csv` | `xlsx`, when known. */
    format: varchar('format', { length: 8 }),

    /** Rows written to the export file; 0 for an import. */
    row_count: integer('row_count').notNull().default(0),

    inserted: integer('inserted').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    failed: integer('failed').notNull().default(0),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('data_transfer_runs_resource_created_idx').on(table.resource, table.created_at)],
);
