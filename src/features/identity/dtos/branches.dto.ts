import { z } from 'zod';
import type { BranchRow } from '../schemas/branches.schema.js';
import type { BranchStaffRow } from '../repositories/branches.repository.js';
import {
  optionalSyrianPhoneSchema,
  nullableSyrianPhoneSchema,
  queryBooleanSchema,
} from '../../../core/validation/common-schemas.js';

/** Mirrors WireBranch below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const branchResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  address: z.string().nullable(),
  contact_info: z.string().nullable(),
  status: z.enum(['active', 'temporarily_closed', 'closed']),
  is_default: z.boolean(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  is_deletable: z.boolean().optional(),
  is_archivable: z.boolean().optional(),
  open_assignments_count: z.number().int().optional(),
  assignments_ever_count: z.number().int().optional(),
  open_ownerships_count: z.number().int().optional(),
  ownerships_ever_count: z.number().int().optional(),
});

/**
 * What removing a record would cost, in the two numbers that decide it — sent
 * on `GET /:id` only, never on a list, because each one is an aggregate and a
 * page of 50 rows would run 200 of them.
 *
 * The pair exists because "nothing points here now" and "nothing ever pointed
 * here" are different facts leading to different actions, and the difference is
 * invisible on screen: a branch whose last employee left in 2024 and a branch
 * created by mistake yesterday both show an empty staff list.
 */
export interface BranchRetirementFacts {
  is_deletable: boolean;
  is_archivable: boolean;
  open_assignments_count: number;
  assignments_ever_count: number;
  open_ownerships_count: number;
  ownerships_ever_count: number;
}

export interface WireBranch {
  id: number;
  name: string;
  address: string | null;
  contact_info: string | null;
  status: 'active' | 'temporarily_closed' | 'closed';
  is_default: boolean;
  /**
   * When this branch was retired from view, or null if it is in service.
   *
   * Sent on every branch, list included, unlike the counts below: it is a plain
   * column, and a client that receives an archived branch (from the archived
   * filter, or from a detail link someone kept) has no other way to know it is
   * looking at one.
   */
  archived_at: string | null;
  created_at: string;
  /** Nothing has EVER pointed here — the row can be destroyed, losing nothing. */
  is_deletable?: boolean;
  /** Nothing points here NOW — the row can be hidden while its history keeps resolving. */
  is_archivable?: boolean;
  open_assignments_count?: number;
  assignments_ever_count?: number;
  open_ownerships_count?: number;
  ownerships_ever_count?: number;
}

export function toWireBranch(row: BranchRow, facts?: BranchRetirementFacts): WireBranch {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    contact_info: row.contact_info,
    status: row.status,
    is_default: row.is_default,
    archived_at: row.archived_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    // Spread whole or omitted, never partially defaulted: a list row that
    // reported `open_assignments_count: 0` would be claiming an empty branch
    // when the truth is that nobody asked.
    ...(facts ?? {}),
  };
}

export const branchIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** Mirrors WireBranchStaffMember for OpenAPI doc generation only. */
export const branchStaffMemberResponseSchema = z.object({
  assignment_id: z.number().int(),
  user_id: z.number().int(),
  full_name: z.string(),
  email: z.string(),
  user_status: z.enum([
    'pending_approval',
    'active',
    'suspended',
    'rejected',
    'disabled',
    'pending_verification',
  ]),
  role_id: z.number().int(),
  role_name: z.string(),
  valid_from: z.string(),
});

export interface WireBranchStaffMember {
  assignment_id: number;
  user_id: number;
  full_name: string;
  email: string;
  user_status:
    | 'pending_approval'
    | 'active'
    | 'suspended'
    | 'rejected'
    | 'disabled'
    | 'pending_verification';
  role_id: number;
  role_name: string;
  valid_from: string;
}

/**
 * `assignment_id` is the payload's whole point beyond display: it is what
 * `POST /role-assignments/:id/transfer|end` take, so the branch screen can act
 * on a row without a second lookup. `user_status` travels with it because a
 * `disabled`/`suspended` holder still occupies the role while counting for
 * nothing — a branch that looks staffed can be effectively empty, and the UI
 * cannot show that distinction unless the status arrives here.
 */
export function toWireBranchStaffMember(row: BranchStaffRow): WireBranchStaffMember {
  return {
    assignment_id: row.assignment_id,
    user_id: row.user_id,
    full_name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    user_status: row.user_status,
    role_id: row.role_id,
    role_name: row.role_name,
    valid_from: row.valid_from.toISOString(),
  };
}

/** See docs/rest_api.md §6.1 Filtering & Sorting — merged with paginationQuerySchema at the route. */
export const branchesFilterQuerySchema = z
  .object({
    status: z.enum(['active', 'temporarily_closed', 'closed']).optional(),
    is_default: queryBooleanSchema.optional(),
    /**
     * Archived rows are excluded unless this says otherwise — the default is
     * the point of archiving, not a convenience.
     *
     * `true` returns ONLY archived branches (the "المؤرشف" view), not archived
     * plus live: a screen offering to show the archive means the archive, and
     * mixing the two back into one list gives the reader no way to tell which
     * is which without checking every row.
     */
    archived: queryBooleanSchema.optional(),
    /** Free-text match across branch name and address. Same contract as `GET /users?search=`. */
    search: z
      .string()
      .trim()
      .max(150)
      .optional()
      .transform((v) => (v !== undefined && v.length > 0 ? v : undefined)),
    sort_by: z.enum(['created_at', 'name']).default('created_at'),
    sort_dir: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type BranchesFilterQuery = z.infer<typeof branchesFilterQuerySchema>;

export const createBranchBodySchema = z.object({
  name: z.string().trim().min(1).max(150),
  address: z.string().trim().max(2000).optional(),
  contact_info: optionalSyrianPhoneSchema,
});
export type CreateBranchBody = z.infer<typeof createBranchBodySchema>;

export const updateBranchBodySchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  address: z.string().trim().max(2000).nullable().optional(),
  contact_info: nullableSyrianPhoneSchema,
  status: z.enum(['active', 'temporarily_closed', 'closed']).optional(),
});
export type UpdateBranchBody = z.infer<typeof updateBranchBodySchema>;
