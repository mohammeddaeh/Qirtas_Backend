import * as dashboardRepository from '../repositories/dashboard.repository.js';
import type {
  WireDashboardStats,
  WireSignal,
  WireStructure,
  WireStructureBranch,
} from '../dtos/dashboard-stats.dto.js';

/** A pending registration is "stale" past this age. Placeholder — no business rule fixes it yet. */
const STALE_PENDING_DAYS = 7;

/** A role held in at most this share of active branches reads as a coverage gap. */
const ROLE_COVERAGE_GAP_RATIO = 0.5;

/** A branch holding more than this share of the organisation's people is a concentration. */
const BRANCH_CONCENTRATION_RATIO = 0.4;

/** A "temporary" closure past this age has stopped being temporary. */
const LONG_CLOSURE_DAYS = 30;

const SEVERITY_ORDER = { critical: 0, serious: 1, warning: 2, info: 3 } as const;

/**
 * Every block is included only if the actor's effective permission set
 * (already resolved once by requirePermission('dashboard.view') at the route)
 * also holds the matching module permission — mirrors the same list screen
 * each card links to (users.manage / branches.manage / roles.view). Omitted
 * blocks are simply absent from the JSON, not zeroed, so the client never
 * receives a number it isn't allowed to see.
 */
export async function getDashboardStats(permissionKeys: string[]): Promise<WireDashboardStats> {
  const canSeeUsers = permissionKeys.includes('users.manage');
  const canSeeBranches = permissionKeys.includes('branches.manage');
  const canSeeRoles = permissionKeys.includes('roles.view');

  const stats: WireDashboardStats = {};

  if (canSeeUsers) {
    const [total, pendingApproval, unassigned, stale] = await Promise.all([
      dashboardRepository.countAllUsers(),
      dashboardRepository.countUsersByStatus('pending_approval'),
      dashboardRepository.countUnassignedActivePeople(),
      dashboardRepository.stalePendingRegistrations(STALE_PENDING_DAYS),
    ]);
    stats.users = {
      total,
      pending_approval: pendingApproval,
      unassigned,
      oldest_pending_days: stale.oldestDays,
    };
  }

  if (canSeeBranches) {
    const [total, unstaffed] = await Promise.all([
      dashboardRepository.countAllBranches(),
      dashboardRepository.unstaffedActiveBranches(),
    ]);
    stats.branches = { total, unstaffed: unstaffed.length };
  }

  if (canSeeRoles) {
    stats.roles = { total: await dashboardRepository.countActiveRoles() };
  }

  if (canSeeUsers && (canSeeBranches || canSeeRoles)) {
    stats.charts = {
      ...(canSeeBranches ? { users_per_branch: await dashboardRepository.usersPerBranch() } : {}),
      ...(canSeeRoles ? { users_per_role: await dashboardRepository.usersPerRole() } : {}),
    };
  }

  // The structure block spans both axes of the branch × role relation, so it
  // requires both module permissions — not either one alone.
  if (canSeeUsers && canSeeBranches) {
    stats.structure = await buildStructure();
  }

  if (canSeeUsers || canSeeBranches) {
    stats.signals = await buildSignals({ canSeeUsers, canSeeBranches });
  }

  return stats;
}

/**
 * Branch headcounts and populated (branch, role) cells are two separate
 * queries on purpose: a person holding two roles in one branch is one person at
 * branch level but appears in two cells, so the branch figure cannot be summed
 * from its own role rows.
 */
async function buildStructure(): Promise<WireStructure> {
  const [people, assignments, unrestricted, branches, cells, roles] = await Promise.all([
    dashboardRepository.countActivePeople(),
    dashboardRepository.countActiveAssignments(),
    dashboardRepository.countUnrestrictedPeople(),
    dashboardRepository.branchHeadcounts(),
    dashboardRepository.branchRoleCells(),
    dashboardRepository.activeRoles(),
  ]);

  const cellsByBranch = new Map<number, WireStructureBranch['roles']>();
  for (const cell of cells) {
    const bucket = cellsByBranch.get(cell.branch_id) ?? [];
    bucket.push({ id: cell.role_id, name: cell.role_name, people: cell.people });
    cellsByBranch.set(cell.branch_id, bucket);
  }

  return {
    people,
    assignments,
    unrestricted_people: unrestricted,
    branches: branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      status: branch.status,
      people: branch.people,
      roles: cellsByBranch.get(branch.id) ?? [],
    })),
    roles,
  };
}

/**
 * Signals are derived here rather than on the client: they are business rules,
 * and the thresholds must not drift between platforms. Each one carries a code
 * plus raw numbers only — the client owns every user-facing string.
 */
async function buildSignals(perms: {
  canSeeUsers: boolean;
  canSeeBranches: boolean;
}): Promise<WireSignal[]> {
  const signals: WireSignal[] = [];

  if (perms.canSeeBranches) {
    const [unstaffed, closedButStaffed, withoutManager, ineffective, longClosed] =
      await Promise.all([
        dashboardRepository.unstaffedActiveBranches(),
        dashboardRepository.closedBranchesWithStaff(),
        dashboardRepository.activeBranchesWithoutManager(),
        dashboardRepository.branchesWithIneffectiveHolders(),
        dashboardRepository.longTemporarilyClosedBranches(LONG_CLOSURE_DAYS),
      ]);

    // A branch with no assignments at all is already reported as
    // `branch_unstaffed`; saying "and it also has no manager" adds a second
    // card for the same fact and buries the branches that DO have staff but
    // nobody in charge — the case nothing else surfaces.
    const unstaffedIds = new Set(unstaffed.map((b) => b.id));

    for (const branch of withoutManager) {
      if (unstaffedIds.has(branch.id)) continue;
      signals.push({
        code: 'branch_without_manager',
        severity: 'serious',
        entity_type: 'branch',
        entity_id: branch.id,
        entity_label: branch.name,
        secondary_id: null,
        secondary_label: null,
        metric: 0,
      });
    }

    for (const branch of ineffective) {
      // metric = how many cannot work; secondary carries the total so the
      // client can say "2 of 4" without a second request.
      signals.push({
        code: 'branch_ineffective_holders',
        severity: Number(branch.ineffective) >= Number(branch.total) ? 'critical' : 'warning',
        entity_type: 'branch',
        entity_id: branch.id,
        entity_label: branch.name,
        secondary_id: Number(branch.total),
        secondary_label: null,
        metric: Number(branch.ineffective),
      });
    }

    for (const branch of longClosed) {
      signals.push({
        code: 'branch_long_closed',
        severity: 'warning',
        entity_type: 'branch',
        entity_id: branch.id,
        entity_label: branch.name,
        secondary_id: null,
        secondary_label: null,
        metric: Number(branch.days),
      });
    }

    for (const branch of unstaffed) {
      signals.push({
        code: 'branch_unstaffed',
        severity: 'critical',
        entity_type: 'branch',
        entity_id: branch.id,
        entity_label: branch.name,
        secondary_id: null,
        secondary_label: null,
        metric: 0,
      });
    }

    for (const branch of closedButStaffed) {
      signals.push({
        code: 'branch_closed_but_staffed',
        severity: 'serious',
        entity_type: 'branch',
        entity_id: branch.id,
        entity_label: branch.name,
        secondary_id: null,
        secondary_label: null,
        metric: branch.people,
      });
    }
  }

  if (perms.canSeeUsers) {
    const [unassigned, stale, unrestricted] = await Promise.all([
      dashboardRepository.countUnassignedActivePeople(),
      dashboardRepository.stalePendingRegistrations(STALE_PENDING_DAYS),
      dashboardRepository.countUnrestrictedPeople(),
    ]);

    if (unassigned > 0) {
      signals.push({
        code: 'user_unassigned',
        severity: 'critical',
        entity_type: 'user',
        entity_id: null,
        entity_label: null,
        secondary_id: null,
        secondary_label: null,
        metric: unassigned,
      });
    }

    if (stale.count > 0) {
      signals.push({
        code: 'pending_stale',
        severity: 'warning',
        entity_type: 'user',
        entity_id: null,
        entity_label: null,
        secondary_id: null,
        secondary_label: null,
        metric: stale.oldestDays,
      });
    }

    if (unrestricted > 0) {
      signals.push({
        code: 'unrestricted_access',
        severity: 'warning',
        entity_type: 'org',
        entity_id: null,
        entity_label: null,
        secondary_id: null,
        secondary_label: null,
        metric: unrestricted,
      });
    }
  }

  if (perms.canSeeUsers && perms.canSeeBranches) {
    const [activeBranches, coverage, singleHolders, branches, totalPeople] = await Promise.all([
      dashboardRepository.countActiveBranches(),
      dashboardRepository.roleCoverage(),
      dashboardRepository.singleHolderCells(),
      dashboardRepository.branchHeadcounts(),
      dashboardRepository.countActivePeople(),
    ]);

    // Coverage is only meaningful against more than one branch — with a single
    // branch every role is trivially "covered in 1 of 1" or absent entirely.
    if (activeBranches > 1) {
      for (const role of coverage) {
        // Zero coverage is a different finding from thin coverage — nobody
        // holds the role anywhere, rather than it being unevenly spread — so it
        // gets its own code instead of reading as "present in 0 branches only".
        if (role.branches === 0) {
          signals.push({
            code: 'role_unheld',
            severity: 'warning',
            entity_type: 'role',
            entity_id: role.id,
            entity_label: role.name,
            secondary_id: null,
            secondary_label: null,
            metric: 0,
          });
        } else if (role.branches <= activeBranches * ROLE_COVERAGE_GAP_RATIO) {
          signals.push({
            code: 'role_undercovered',
            severity: 'warning',
            entity_type: 'role',
            entity_id: role.id,
            entity_label: role.name,
            secondary_id: null,
            secondary_label: null,
            metric: role.branches,
          });
        }
      }
    }

    for (const cell of singleHolders) {
      signals.push({
        code: 'role_single_holder',
        severity: 'warning',
        entity_type: 'branch_role',
        entity_id: cell.branch_id,
        entity_label: cell.branch_name,
        // The role id travels too, so the card can open that exact role
        // instead of dropping the reader on an unfiltered list.
        secondary_id: cell.role_id,
        secondary_label: cell.role_name,
        metric: 1,
      });
    }

    // Concentration needs at least two branches to mean anything: a lone branch
    // trivially holds 100% of the organisation's people.
    if (totalPeople > 0 && branches.length > 1) {
      for (const branch of branches) {
        const share = branch.people / totalPeople;
        if (share > BRANCH_CONCENTRATION_RATIO) {
          signals.push({
            code: 'branch_concentration',
            severity: 'info',
            entity_type: 'branch',
            entity_id: branch.id,
            entity_label: branch.name,
            secondary_id: null,
            secondary_label: null,
            metric: Math.round(share * 100),
          });
        }
      }
    }
  }

  return signals.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
