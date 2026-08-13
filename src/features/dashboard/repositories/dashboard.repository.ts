import { eq, and, isNull, isNotNull, inArray, count, countDistinct, sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { usersTable } from '../../identity/schemas/users.schema.js';
import { branchesTable } from '../../identity/schemas/branches.schema.js';
import { rolesTable } from '../../identity/schemas/roles.schema.js';
import { userRoleAssignmentsTable } from '../../identity/schemas/user-role-assignments.schema.js';
import type { WireChartPoint } from '../dtos/dashboard-stats.dto.js';

const isActiveAssignmentClause = sql`(${userRoleAssignmentsTable.valid_to} IS NULL OR ${userRoleAssignmentsTable.valid_to} > now())`;

/**
 * Archived records are out of every figure on this dashboard.
 *
 * The dashboard answers "what does the organisation look like right now", and
 * an archived branch or account is precisely the row an admin has declared is
 * no longer part of that answer. Counting them would put a headline number here
 * that disagrees with the list it links to — the reader taps "12 فروع", lands on
 * a list of 11, and has no way to find the twelfth.
 *
 * Only the queries that read these tables DIRECTLY need the clause. Anything
 * driven from `user_role_assignments` is already safe: archiving requires zero
 * open assignments, so an archived row contributes none. And anything filtered
 * to `branches.status = 'active'` or `users.status = 'active'` is safe by the
 * invariant archiving establishes — it writes `closed`/`disabled` in the same
 * statement, never leaving a hidden row wearing an operating status.
 */
const liveUser = sql`${usersTable.archived_at} IS NULL`;
const liveBranch = sql`${branchesTable.archived_at} IS NULL`;
const liveRole = sql`${rolesTable.archived_at} IS NULL`;

export async function countAllUsers(): Promise<number> {
  const rows = await db.select({ value: count() }).from(usersTable).where(liveUser);
  return rows[0]?.value ?? 0;
}

export async function countUsersByStatus(status: (typeof usersTable.status.enumValues)[number]): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(usersTable)
    .where(and(liveUser, eq(usersTable.status, status)));
  return rows[0]?.value ?? 0;
}

export async function countAllBranches(): Promise<number> {
  const rows = await db.select({ value: count() }).from(branchesTable).where(liveBranch);
  return rows[0]?.value ?? 0;
}

export async function countActiveRoles(): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(rolesTable)
    .where(and(liveRole, eq(rolesTable.is_active, true)));
  return rows[0]?.value ?? 0;
}

/**
 * Distinct people per branch — driven FROM branchesTable via leftJoin, so a
 * branch with zero active assignments still yields a row with value 0. An
 * innerJoin here would emit no row at all for an empty branch, which makes a
 * coverage gap structurally invisible to every caller (chart or matrix alike).
 *
 * Counts DISTINCT users, not assignment rows: one person holding two roles in
 * the same branch is one person. Assignment totals are a separate figure — see
 * countActiveAssignments().
 *
 * Users on an unrestricted assignment (branch_id NULL = all branches) belong to
 * no single branch and are therefore absent here by definition; they are
 * reported on their own via countUnrestrictedPeople().
 */
export async function usersPerBranch(): Promise<WireChartPoint[]> {
  const rows = await db
    .select({ label: branchesTable.name, value: countDistinct(userRoleAssignmentsTable.user_id) })
    .from(branchesTable)
    .leftJoin(
      userRoleAssignmentsTable,
      and(eq(userRoleAssignmentsTable.branch_id, branchesTable.id), isActiveAssignmentClause),
    )
    .where(liveBranch)
    .groupBy(branchesTable.id, branchesTable.name)
    .orderBy(branchesTable.name);
  return rows;
}

/** Distinct people per role — leftJoin from rolesTable so an unfilled role still yields 0. */
export async function usersPerRole(): Promise<WireChartPoint[]> {
  const rows = await db
    .select({ label: rolesTable.name, value: countDistinct(userRoleAssignmentsTable.user_id) })
    .from(rolesTable)
    .leftJoin(
      userRoleAssignmentsTable,
      and(eq(userRoleAssignmentsTable.role_id, rolesTable.id), isActiveAssignmentClause),
    )
    .where(and(liveRole, eq(rolesTable.is_active, true)))
    .groupBy(rolesTable.id, rolesTable.name)
    .orderBy(rolesTable.name);
  return rows;
}

/** Distinct people holding at least one active assignment anywhere. */
export async function countActivePeople(): Promise<number> {
  const rows = await db
    .select({ value: countDistinct(userRoleAssignmentsTable.user_id) })
    .from(userRoleAssignmentsTable)
    .where(isActiveAssignmentClause);
  return rows[0]?.value ?? 0;
}

/**
 * Active assignment rows. Deliberately separate from countActivePeople(): the
 * two legitimately differ (multi-role / multi-branch people) and the UI is
 * required to label them differently rather than present either as "users".
 */
export async function countActiveAssignments(): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(userRoleAssignmentsTable)
    .where(isActiveAssignmentClause);
  return rows[0]?.value ?? 0;
}

/** Distinct people on an unrestricted assignment (branch_id NULL = every branch). */
export async function countUnrestrictedPeople(): Promise<number> {
  const rows = await db
    .select({ value: countDistinct(userRoleAssignmentsTable.user_id) })
    .from(userRoleAssignmentsTable)
    .where(and(isNull(userRoleAssignmentsTable.branch_id), isActiveAssignmentClause));
  return rows[0]?.value ?? 0;
}

// ─── Structure (branch × role) ────────────────────────────────────────────────

export interface BranchHeadRow {
  id: number;
  name: string;
  status: (typeof branchesTable.status.enumValues)[number];
  people: number;
}

export interface BranchRoleCellRow {
  branch_id: number;
  role_id: number;
  role_name: string;
  people: number;
}

/** Every branch with its distinct headcount — leftJoin keeps the empty branch present at 0. */
export async function branchHeadcounts(): Promise<BranchHeadRow[]> {
  return db
    .select({
      id: branchesTable.id,
      name: branchesTable.name,
      status: branchesTable.status,
      people: countDistinct(userRoleAssignmentsTable.user_id),
    })
    .from(branchesTable)
    .leftJoin(
      userRoleAssignmentsTable,
      and(eq(userRoleAssignmentsTable.branch_id, branchesTable.id), isActiveAssignmentClause),
    )
    .where(liveBranch)
    .groupBy(branchesTable.id, branchesTable.name, branchesTable.status)
    .orderBy(branchesTable.name);
}

/**
 * One row per populated (branch, role) pair — the matrix cells that are NOT
 * empty. Absent pairs are the gaps and are reconstructed client-side against
 * the full branch and role lists; materialising a full cross join here would
 * ship O(branches × roles) mostly-zero rows over the wire for no gain.
 */
export async function branchRoleCells(): Promise<BranchRoleCellRow[]> {
  return db
    .select({
      branch_id: sql<number>`${userRoleAssignmentsTable.branch_id}`.mapWith(Number),
      role_id: rolesTable.id,
      role_name: rolesTable.name,
      people: countDistinct(userRoleAssignmentsTable.user_id),
    })
    .from(userRoleAssignmentsTable)
    .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
    .where(and(isNotNull(userRoleAssignmentsTable.branch_id), isActiveAssignmentClause))
    .groupBy(userRoleAssignmentsTable.branch_id, rolesTable.id, rolesTable.name)
    .orderBy(rolesTable.name);
}

/** Active roles — the matrix column axis, including roles nobody holds yet. */
export async function activeRoles(): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: rolesTable.id, name: rolesTable.name })
    .from(rolesTable)
    .where(and(liveRole, eq(rolesTable.is_active, true)))
    .orderBy(rolesTable.name);
}

// ─── Signals ──────────────────────────────────────────────────────────────────

/** Active branches carrying zero active assignments — a coverage gap. */
export async function unstaffedActiveBranches(): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: branchesTable.id, name: branchesTable.name })
    .from(branchesTable)
    .leftJoin(
      userRoleAssignmentsTable,
      and(eq(userRoleAssignmentsTable.branch_id, branchesTable.id), isActiveAssignmentClause),
    )
    .where(eq(branchesTable.status, 'active'))
    .groupBy(branchesTable.id, branchesTable.name)
    .having(sql`count(${userRoleAssignmentsTable.id}) = 0`);
}

/**
 * Active accounts with no active assignment anywhere — the mirror of an empty
 * branch: a person who exists but belongs nowhere, and who therefore appears in
 * no branch, no role and no chart.
 */
export async function countUnassignedActivePeople(): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.status, 'active'),
        sql`NOT EXISTS (
          SELECT 1 FROM ${userRoleAssignmentsTable} a
          WHERE a.user_id = ${usersTable.id}
            AND (a.valid_to IS NULL OR a.valid_to > now())
        )`,
      ),
    );
  return rows[0]?.value ?? 0;
}

/** Closed / temporarily-closed branches still holding active assignments — a state contradiction. */
export async function closedBranchesWithStaff(): Promise<
  { id: number; name: string; people: number }[]
> {
  return db
    .select({
      id: branchesTable.id,
      name: branchesTable.name,
      people: countDistinct(userRoleAssignmentsTable.user_id),
    })
    .from(branchesTable)
    .innerJoin(
      userRoleAssignmentsTable,
      and(eq(userRoleAssignmentsTable.branch_id, branchesTable.id), isActiveAssignmentClause),
    )
    .where(inArray(branchesTable.status, ['temporarily_closed', 'closed']))
    .groupBy(branchesTable.id, branchesTable.name);
}

/** Active branch count — denominator for role coverage. */
export async function countActiveBranches(): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(branchesTable)
    .where(eq(branchesTable.status, 'active'));
  return rows[0]?.value ?? 0;
}

/** Per active role: how many distinct branches hold it (the matrix column footer). */
export async function roleCoverage(): Promise<{ id: number; name: string; branches: number }[]> {
  return db
    .select({
      id: rolesTable.id,
      name: rolesTable.name,
      branches: countDistinct(userRoleAssignmentsTable.branch_id),
    })
    .from(rolesTable)
    .leftJoin(
      userRoleAssignmentsTable,
      and(
        eq(userRoleAssignmentsTable.role_id, rolesTable.id),
        isNotNull(userRoleAssignmentsTable.branch_id),
        isActiveAssignmentClause,
      ),
    )
    .where(and(liveRole, eq(rolesTable.is_active, true)))
    .groupBy(rolesTable.id, rolesTable.name);
}

/** (branch, role) pairs held by exactly one person — a single point of failure. */
export async function singleHolderCells(): Promise<
  { branch_id: number; branch_name: string; role_id: number; role_name: string }[]
> {
  return db
    .select({
      branch_id: branchesTable.id,
      branch_name: branchesTable.name,
      role_id: rolesTable.id,
      role_name: rolesTable.name,
    })
    .from(userRoleAssignmentsTable)
    .innerJoin(branchesTable, eq(branchesTable.id, userRoleAssignmentsTable.branch_id))
    .innerJoin(rolesTable, eq(rolesTable.id, userRoleAssignmentsTable.role_id))
    .where(isActiveAssignmentClause)
    .groupBy(branchesTable.id, branchesTable.name, rolesTable.id, rolesTable.name)
    .having(sql`count(distinct ${userRoleAssignmentsTable.user_id}) = 1`);
}

/**
 * Active branches with nobody in charge — zero active-account holders of any
 * `management`-category role.
 *
 * "Manager" is not a hard-coded role name: naming it would break the moment an
 * organisation renames or splits the role. The role *category* is the stable
 * concept, and it is already required on every role.
 *
 * Why this cannot be read off `role_undercovered`: that signal says a role is
 * held in few branches and names none of them, so it reports a number nobody
 * can act on. This names the branches (production_readiness.md §C2).
 */
export async function activeBranchesWithoutManager(): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: branchesTable.id, name: branchesTable.name })
    .from(branchesTable)
    .leftJoin(
      userRoleAssignmentsTable,
      and(eq(userRoleAssignmentsTable.branch_id, branchesTable.id), isActiveAssignmentClause),
    )
    // Both joins inside the ON clause, never in WHERE: moving either one there
    // would collapse the leftJoin into an innerJoin and drop precisely the
    // branches with no manager — the rows this query exists to find.
    .leftJoin(
      rolesTable,
      and(eq(rolesTable.id, userRoleAssignmentsTable.role_id), eq(rolesTable.category, 'management')),
    )
    .leftJoin(
      usersTable,
      and(eq(usersTable.id, userRoleAssignmentsTable.user_id), eq(usersTable.status, 'active')),
    )
    .where(eq(branchesTable.status, 'active'))
    .groupBy(branchesTable.id, branchesTable.name)
    .having(
      sql`count(distinct case when ${rolesTable.id} is not null and ${usersTable.id} is not null then ${userRoleAssignmentsTable.user_id} end) = 0`,
    );
}

/**
 * Active branches holding assignments whose accounts cannot work
 * (`suspended`/`disabled`/`pending_approval`/`rejected`).
 *
 * A headcount cannot express this: the branch has people on paper and fewer —
 * sometimes none — in practice. `branch_unstaffed` counts assignments and so
 * calls such a branch staffed; `role_single_holder` counts distinct users
 * without checking their status and so calls a branch covered when its only
 * holder is disabled.
 */
export async function branchesWithIneffectiveHolders(): Promise<
  { id: number; name: string; ineffective: number; total: number }[]
> {
  return db
    .select({
      id: branchesTable.id,
      name: branchesTable.name,
      ineffective: sql<number>`count(*) filter (where ${usersTable.status} <> 'active')`,
      total: sql<number>`count(*)`,
    })
    .from(userRoleAssignmentsTable)
    .innerJoin(branchesTable, eq(branchesTable.id, userRoleAssignmentsTable.branch_id))
    .innerJoin(usersTable, eq(usersTable.id, userRoleAssignmentsTable.user_id))
    .where(and(eq(branchesTable.status, 'active'), isActiveAssignmentClause))
    .groupBy(branchesTable.id, branchesTable.name)
    .having(sql`count(*) filter (where ${usersTable.status} <> 'active') > 0`);
}

/**
 * Branches paused for longer than `days`.
 *
 * "Temporary" with no deadline becomes permanent quietly — the branch stops
 * appearing in operational choices while its assignments stay open, so nobody
 * is prompted to decide anything. Measured from `status_changed_at`, which is
 * why that column exists.
 */
export async function longTemporarilyClosedBranches(
  days: number,
): Promise<{ id: number; name: string; days: number }[]> {
  return db
    .select({
      id: branchesTable.id,
      name: branchesTable.name,
      days: sql<number>`trunc(extract(day from now() - ${branchesTable.status_changed_at}))`,
    })
    .from(branchesTable)
    .where(
      and(
        eq(branchesTable.status, 'temporarily_closed'),
        sql`${branchesTable.status_changed_at} < now() - make_interval(days => ${days})`,
      ),
    );
}

/** Pending registrations older than `days` — count plus the age of the oldest. */
export async function stalePendingRegistrations(
  days: number,
): Promise<{ count: number; oldestDays: number }> {
  const rows = await db
    .select({
      value: count(),
      oldest: sql<number | null>`extract(day from now() - min(${usersTable.submitted_at}))`,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.status, 'pending_approval'),
        sql`${usersTable.submitted_at} < now() - make_interval(days => ${days})`,
      ),
    );
  return { count: rows[0]?.value ?? 0, oldestDays: Math.trunc(Number(rows[0]?.oldest ?? 0)) };
}
