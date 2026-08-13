import { pgTable, varchar, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../../../features/identity/schemas/users.schema.js';

/**
 * Holds a validated-but-not-yet-committed import between the two phases of
 * `POST /import`.
 *
 * **Why a table and not a process-local Map.** The obvious cheap version keeps
 * the rows in memory keyed by token. It works on a laptop and fails in every
 * real deployment: two instances behind a load balancer put the validate and
 * the commit on different processes, so the commit answers "token expired" for
 * a token issued seconds earlier — intermittently, in proportion to instance
 * count, and never on the developer's machine. A restart between the two
 * phases does the same thing to a single instance.
 *
 * **What is stored is the raw text the user uploaded**, not the typed rows
 * produced by validation. Commit re-runs the resource's `rowSchema` over it
 * rather than trusting what was written here, which costs one cheap pass and
 * buys two things: the payload survives JSON round-tripping (a `Date` written
 * to `jsonb` comes back a string, and a schema expecting a `Date` would then
 * reject its own output), and a row cannot enter the database on the strength
 * of a staging record alone.
 *
 * This is the one table `core/` owns. It is infrastructure for a mechanism
 * every feature shares, not data belonging to any of them.
 */
export const importStagingTable = pgTable(
  'import_staging',
  {
    /** `imp_` + 32 hex chars from `crypto.randomBytes`. Unguessable — it is the only thing standing between a token and someone else's pending import, alongside the owner check. */
    token: varchar('token', { length: 40 }).primaryKey(),

    /**
     * The owner. Every read is scoped to it in the WHERE clause, so a leaked
     * token is still useless to another account — and cascades on delete,
     * because a pending import belonging to a deleted account can never be
     * committed by anyone.
     */
    user_id: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),

    /** Bound at validate time and re-checked at commit: a token issued for `notes` cannot be spent against another resource. */
    resource: varchar('resource', { length: 64 }).notNull(),

    /** `Array<Record<columnKey, rawCellText>>` — exactly the accepted rows, in file order. */
    rows: jsonb('rows').notNull(),

    row_count: integer('row_count').notNull(),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Fifteen minutes out. Long enough to read an error report and decide,
     * short enough that an abandoned import is not an indefinite copy of
     * someone's data sitting in the database.
     */
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // Sweeping expired rows is `DELETE WHERE expires_at < now()`, which without
    // this index is a sequential scan running on every validate call.
    index('import_staging_expires_idx').on(table.expires_at),
  ],
);

export type ImportStagingRow = typeof importStagingTable.$inferSelect;
