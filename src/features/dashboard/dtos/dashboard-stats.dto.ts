import { z } from 'zod';

/** Mirrors WireDashboardStats below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const usersStatsResponseSchema = z.object({
  total: z.number().int(),
  pending_approval: z.number().int(),
  /** Active accounts holding no active assignment — see WireUsersStats.unassigned. */
  unassigned: z.number().int(),
  /** Age in days of the oldest still-pending registration; 0 when none is stale. */
  oldest_pending_days: z.number().int(),
});

export const branchesStatsResponseSchema = z.object({
  total: z.number().int(),
  unstaffed: z.number().int(),
});

export const rolesStatsResponseSchema = z.object({
  total: z.number().int(),
});

export const chartPointResponseSchema = z.object({
  label: z.string(),
  value: z.number().int(),
});

export const dashboardChartsResponseSchema = z.object({
  users_per_branch: z.array(chartPointResponseSchema).optional(),
  users_per_role: z.array(chartPointResponseSchema).optional(),
});

export const structureRoleResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  people: z.number().int(),
});

export const structureBranchResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.enum(['active', 'temporarily_closed', 'closed']),
  people: z.number().int(),
  roles: z.array(structureRoleResponseSchema),
});

export const structureResponseSchema = z.object({
  people: z.number().int(),
  assignments: z.number().int(),
  unrestricted_people: z.number().int(),
  branches: z.array(structureBranchResponseSchema),
  roles: z.array(z.object({ id: z.number().int(), name: z.string() })),
});

export const signalResponseSchema = z.object({
  code: z.string(),
  severity: z.enum(['critical', 'serious', 'warning', 'info']),
  entity_type: z.enum(['branch', 'role', 'branch_role', 'user', 'org']),
  entity_id: z.number().int().nullable(),
  entity_label: z.string().nullable(),
  secondary_id: z.number().int().nullable(),
  secondary_label: z.string().nullable(),
  metric: z.number(),
});

export const dashboardStatsResponseSchema = z.object({
  users: usersStatsResponseSchema.optional(),
  branches: branchesStatsResponseSchema.optional(),
  roles: rolesStatsResponseSchema.optional(),
  charts: dashboardChartsResponseSchema.optional(),
  structure: structureResponseSchema.optional(),
  signals: z.array(signalResponseSchema).optional(),
});

export interface WireUsersStats {
  total: number;
  pending_approval: number;
  /**
   * Active accounts with no active assignment anywhere — people who exist in
   * the system but belong to no branch and hold no role, and who therefore
   * appear in no other figure on this endpoint.
   */
  unassigned: number;
  oldest_pending_days: number;
}

export interface WireBranchesStats {
  total: number;
  unstaffed: number;
}

export interface WireRolesStats {
  total: number;
}

export interface WireChartPoint {
  label: string;
  value: number;
}

export interface WireDashboardCharts {
  users_per_branch?: WireChartPoint[];
  users_per_role?: WireChartPoint[];
}

export interface WireStructureRole {
  id: number;
  name: string;
  people: number;
}

export interface WireStructureBranch {
  id: number;
  name: string;
  status: 'active' | 'temporarily_closed' | 'closed';
  people: number;
  /** Only the roles actually held in this branch; an absent role is a gap, reconstructed against `WireStructure.roles`. */
  roles: WireStructureRole[];
}

export interface WireStructure {
  /** Distinct people holding at least one active assignment. */
  people: number;
  /**
   * Active assignment rows. Legitimately differs from `people` — one person may
   * hold several roles or work across branches — so the two are named
   * differently and the client must never present either as the other.
   */
  assignments: number;
  unrestricted_people: number;
  branches: WireStructureBranch[];
  /** The full active-role axis, so the client can tell an absent cell from an unknown one. */
  roles: { id: number; name: string }[];
}

export type WireSignalSeverity = 'critical' | 'serious' | 'warning' | 'info';

/**
 * A signal carries a machine code and the raw numbers — never presentation
 * prose. The app is bilingual (ar/en) and localises from `code` via LocaleKeys;
 * a server-rendered string would not follow a locale change on the device.
 */
export interface WireSignal {
  code: string;
  severity: WireSignalSeverity;
  entity_type: 'branch' | 'role' | 'branch_role' | 'user' | 'org';
  entity_id: number | null;
  entity_label: string | null;
  /**
   * Second half of a composite entity — the role in a `branch_role` cell. The
   * id is carried alongside the label so a client can navigate straight to that
   * role instead of dumping the reader on an unfiltered list.
   */
  secondary_id: number | null;
  secondary_label: string | null;
  metric: number;
}

/** Every top-level block is present only if the requesting actor holds the matching module permission. */
export interface WireDashboardStats {
  users?: WireUsersStats;
  branches?: WireBranchesStats;
  roles?: WireRolesStats;
  charts?: WireDashboardCharts;
  structure?: WireStructure;
  signals?: WireSignal[];
}
