import { eq, asc, desc, and, count, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { findManyPaginated, findOneById } from '../../../core/db/crud-helpers.js';
import { likeTerm } from '../../../core/db/like-term.js';
import { branchesTable, type BranchRow, type NewBranchRow } from '../schemas/branches.schema.js';
import { usersTable, type UserRow } from '../schemas/users.schema.js';
import { rolesTable } from '../schemas/roles.schema.js';
import { userRoleAssignmentsTable } from '../schemas/user-role-assignments.schema.js';
import type { PaginationParams } from '../../../core/pagination/pagination.js';
import type { BranchesFilterQuery, CreateBranchBody } from '../dtos/branches.dto.js';

const sortColumns = {
  created_at: branchesTable.created_at,
  name: branchesTable.name,
} as const;

export function findMany(
  params: PaginationParams,
  filter: BranchesFilterQuery,
): Promise<{ rows: BranchRow[]; total: number }> {
  const conditions: SQL[] = [];
  // Applied before anything else and never absent: every other filter narrows
  // within a set that has already had the archive taken out of it (or, when
  // asked, consists only of it).
  conditions.push(
    filter.archived === true
      ? sql`${branchesTable.archived_at} IS NOT NULL`
      : sql`${branchesTable.archived_at} IS NULL`,
  );
  if (filter.status !== undefined) conditions.push(eq(branchesTable.status, filter.status));
  if (filter.is_default !== undefined) {
    conditions.push(eq(branchesTable.is_default, filter.is_default));
  }
  if (filter.search !== undefined && filter.search.length > 0) {
    // Address included, not just name: branches are commonly identified by
    // where they are ("الزراعة", "الكورنيش") as much as by what they are called.
    const term = likeTerm(filter.search);
    conditions.push(
      sql`(${branchesTable.name} ILIKE ${term} OR ${branchesTable.address} ILIKE ${term})`,
    );
  }

  const orderFn = filter.sort_dir === 'asc' ? asc : desc;

  return findManyPaginated<BranchRow>(branchesTable, params, {
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: orderFn(sortColumns[filter.sort_by]),
  });
}

export function findById(id: number): Promise<BranchRow | undefined> {
  return findOneById<BranchRow>(branchesTable, branchesTable.id, id);
}

/**
 * Whether a visitor may name this branch on a registration request.
 *
 * Two conditions, each for its own reason:
 * - not archived — an archived branch accepts no new assignment at all
 *   (`branch_archived`), so approving a request that names one would fail at
 *   the last step, after a person had already been told to wait for a decision.
 * - not `closed` — that is the permanent state, reached only after every
 *   assignment has been cleared out. Applying to work somewhere that has shut
 *   for good is not a request an admin can grant.
 *
 * `temporarily_closed` deliberately stays in: it is a branch that is expected
 * back, staffing one before it reopens is legitimate (the admin picker allows
 * exactly that), and the picker renders the state next to the name — so the
 * applicant is never choosing it blind.
 *
 * The single definition behind BOTH the public catalog and the register
 * endpoint's guard — a catalog the write path does not enforce is decorative.
 */
export function isSelfRegisterable(row: BranchRow): boolean {
  return row.archived_at === null && row.status !== 'closed';
}

/**
 * The branch catalog a self-registering visitor picks from — every branch
 * [isSelfRegisterable] accepts.
 *
 * Unpaginated on purpose: a bounded catalog read by an anonymous form that has
 * nowhere to put a "load more", exactly like the roles one it mirrors.
 */
export function findSelfRegisterable(): Promise<BranchRow[]> {
  return db
    .select()
    .from(branchesTable)
    .where(
      and(
        sql`${branchesTable.archived_at} IS NULL`,
        sql`${branchesTable.status} <> 'closed'`,
      ),
    )
    .orderBy(asc(branchesTable.name));
}

/**
 * Branches a visitor can be opened on automatically: in service (`active` — a
 * temporarily closed branch must not be the one silently chosen for someone)
 * and not archived.
 */
export function findAutoSelectable(): Promise<BranchRow[]> {
  return db
    .select()
    .from(branchesTable)
    .where(and(sql`${branchesTable.archived_at} IS NULL`, eq(branchesTable.status, 'active')))
    .orderBy(asc(branchesTable.id));
}

/**
 * Name lookup for the uniqueness guard — searches archived rows too, and must.
 *
 * `branches_name_unique_idx` is a plain unique index, not partial on
 * `archived_at`, so an archived branch still owns its name. Skipping archived
 * rows here would let the service promise a create that the database then
 * rejects as a constraint error, over a row the admin cannot see in any list.
 */
export async function findByName(name: string): Promise<BranchRow | undefined> {
  const rows = await db.select().from(branchesTable).where(eq(branchesTable.name, name)).limit(1);
  return rows[0];
}

/** One active assignment in a branch, flattened with the person and the role it grants. */
export interface BranchStaffRow {
  assignment_id: number;
  user_id: number;
  first_name: string;
  last_name: string;
  email: string;
  user_status: UserRow['status'];
  role_id: number;
  role_name: string;
  valid_from: Date;
}

/**
 * The people actually working in a branch, one row per active assignment.
 *
 * Keyed on the assignment, not the user, deliberately: one person may hold two
 * roles in the same branch, and collapsing that to a single row would hide the
 * second role and — worse — leave the UI with no `assignment_id` to transfer or
 * end. Unrestricted holders (`branch_id IS NULL`) are NOT included: they are
 * not staff *of* this branch, they simply are not confined to any (the same
 * boundary the dashboard's `structure` block draws).
 */
export async function findStaff(
  branchId: number,
  params: PaginationParams,
): Promise<{ rows: BranchStaffRow[]; total: number }> {
  const where = and(
    eq(userRoleAssignmentsTable.branch_id, branchId),
    sql`(${userRoleAssignmentsTable.valid_to} IS NULL OR ${userRoleAssignmentsTable.valid_to} > now())`,
  );

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        assignment_id: userRoleAssignmentsTable.id,
        user_id: usersTable.id,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        email: usersTable.email,
        user_status: usersTable.status,
        role_id: rolesTable.id,
        role_name: rolesTable.name,
        valid_from: userRoleAssignmentsTable.valid_from,
      })
      .from(userRoleAssignmentsTable)
      .innerJoin(usersTable, eq(usersTable.id, userRoleAssignmentsTable.user_id))
      .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
      .where(where)
      // Newest assignment first, then a stable tiebreaker — without one, two
      // rows sharing a valid_from can swap places between pages and a person
      // appears twice or not at all.
      .orderBy(desc(userRoleAssignmentsTable.valid_from), desc(userRoleAssignmentsTable.id))
      .limit(params.limit)
      .offset(params.offset),
    db
      .select({ value: count() })
      .from(userRoleAssignmentsTable)
      .innerJoin(usersTable, eq(usersTable.id, userRoleAssignmentsTable.user_id))
      .where(where),
  ]);

  return { rows, total: totalRows[0]?.value ?? 0 };
}

/**
 * Branches in service — the dashboard's headline count.
 *
 * Excludes archived rows for the same reason the list does: the number is read
 * as "how many branches do we have", and an archive nobody was told about would
 * silently inflate it.
 */
export async function countAll(): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(branchesTable)
    .where(sql`${branchesTable.archived_at} IS NULL`);
  return rows[0]?.value ?? 0;
}

/**
 * Destroys the row. Callable only after the service has established that
 * nothing has ever pointed at it — `user_role_assignments.branch_id` and
 * `ownerships.branch_scope` are both `RESTRICT`, so a mistake here surfaces as
 * a driver error rather than a sentence.
 *
 * `users.requested_branch_id` and `audit_log_entries.branch_context` are `SET
 * NULL` and need no check: the first is a request whose branch no longer
 * exists, the second an entry that keeps its own copy of what changed.
 */
export async function deleteById(id: number): Promise<void> {
  await db.delete(branchesTable).where(eq(branchesTable.id, id));
}

export async function insert(data: NewBranchRow): Promise<BranchRow> {
  const rows = await db.insert(branchesTable).values(data).returning();
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return row;
}

export async function update(
  id: number,
  data: Partial<NewBranchRow>,
): Promise<BranchRow | undefined> {
  const rows = await db.update(branchesTable).set(data).where(eq(branchesTable.id, id)).returning();
  return rows[0];
}

// ─── Data transfer (export / import) ─────────────────────────────────────────
//
// Serve `branches.transfer.ts`. Kept here with every other query so the search
// predicate below stays identical to the one `findMany` uses — an export whose
// filter drifted from the list's would quietly return a different set than the
// screen the user was looking at.

function transferWhere(search: string | undefined): SQL {
  // Archived rows are out of scope for export, matching the list: a spreadsheet
  // of "our branches" that quietly carries retired ones gets re-imported into
  // another system as live records.
  const live = sql`${branchesTable.archived_at} IS NULL`;
  if (search === undefined || search.trim() === '') return live;
  const term = likeTerm(search.trim());
  return and(
    live,
    sql`(${branchesTable.name} ILIKE ${term} OR ${branchesTable.address} ILIKE ${term})`,
  )!;
}

export async function countForExport(search?: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(branchesTable)
    .where(transferWhere(search));
  return rows[0]?.value ?? 0;
}

/**
 * Yields every matching branch, one batch at a time.
 *
 * **Keyset on `id`, not OFFSET.** `OFFSET n` makes Postgres walk and discard n
 * rows per page, so the cost grows quadratically and the last pages are the
 * slowest — an export that appears to hang exactly as it finishes. `WHERE id >
 * lastId ORDER BY id` uses the primary key for every batch and costs the same
 * at row 5 000 as at row 1.
 *
 * `id ASC` rather than the list's `created_at DESC` because a keyset cursor
 * needs a unique, monotonic column; `created_at` is neither, and two branches
 * sharing a timestamp would skip or repeat across a batch boundary.
 */
export async function* iterateForExport(
  search: string | undefined,
  batchSize = 500,
): AsyncGenerator<BranchRow> {
  let lastId = 0;

  for (;;) {
    const scope = transferWhere(search);
    const batch = await db
      .select()
      .from(branchesTable)
      .where(and(scope, gt(branchesTable.id, lastId)))
      .orderBy(asc(branchesTable.id))
      .limit(batchSize);

    if (batch.length === 0) return;
    for (const row of batch) yield row;

    lastId = batch[batch.length - 1]!.id;
    if (batch.length < batchSize) return;
  }
}

/**
 * Writes an imported batch — **the whole batch or none of it.**
 *
 * The transaction is the promise the two-phase import makes: the user saw a
 * report saying N rows are valid and pressed confirm. A partial write leaves
 * them unable to tell which landed, and re-importing to find out duplicates
 * whatever did.
 *
 * `is_default` and `status` are never taken from the file — they are absent
 * from `createBranchBodySchema` for the same reason. A spreadsheet that could
 * set `is_default` would let an import silently move the default branch, which
 * is an organisational decision, not a data entry one.
 */
export async function insertManyFromImport(
  rows: CreateBranchBody[],
): Promise<{ inserted: number; updated: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

  const CHUNK = 500;
  let inserted = 0;

  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({
        name: r.name,
        address: r.address ?? null,
        contact_info: r.contact_info ?? null,
      }));
      const written = await tx
        .insert(branchesTable)
        .values(chunk)
        .returning({ id: branchesTable.id });
      inserted += written.length;
    }
  });

  return { inserted, updated: 0, skipped: 0 };
}

/**
 * Which of these branch names already exist — one query for the whole batch.
 *
 * Serves duplicate detection at import time. One query rather than one per row:
 * a 500-row file would otherwise issue 500 round trips inside a single
 * validation request.
 *
 * The comparison must match `duplicateKey` exactly — trimmed, lower-cased,
 * whitespace-collapsed — or "الفرع الرئيسي" and "الفرع الرئيسي " are two records
 * here and one to anybody looking at the list. `lower(regexp_replace(...))` does
 * on the database side what the engine did on the file side.
 *
 * ## `\\s`, not `\s` — the backslash has to survive JavaScript first
 *
 * This is a template literal, so `'\s+'` is not the regex `\s+`: JavaScript
 * drops the backslash of an unrecognised escape and Postgres receives `'s+'`,
 * a pattern matching the **letter s**. It was written that way, and the effect
 * was silent in the worst direction — the query still ran, still returned rows,
 * and still matched every name whose spacing was already canonical. Only a name
 * the engine had to normalise (double space, stray tab) failed to match, so
 * "فرع  مركز" was reported as new, passed validation with no error at all, and
 * died at the unique index during commit — after the staging token had been
 * spent, with a 500 where the review screen should have shown a red cell
 * (reported 2026-08-13).
 */
export async function findExistingNames(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();

  const normalised = sql`lower(regexp_replace(btrim(${branchesTable.name}), '\\s+', ' ', 'g'))`;
  const rows = await db
    .select({ key: normalised })
    .from(branchesTable)
    .where(inArray(normalised, keys));

  return new Set(rows.map((r) => r.key as string));
}
