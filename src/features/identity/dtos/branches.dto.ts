import { z } from 'zod';
import type { BranchRow } from '../schemas/branches.schema.js';
import type { BranchStaffRow } from '../repositories/branches.repository.js';
import { optionalSyrianPhoneSchema, nullableSyrianPhoneSchema } from '../../../core/validation/common-schemas.js';

/** Mirrors WireBranch below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const branchResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  address: z.string().nullable(),
  contact_info: z.string().nullable(),
  status: z.enum(['active', 'temporarily_closed', 'closed']),
  is_default: z.boolean(),
  created_at: z.string(),
});

export interface WireBranch {
  id: number;
  name: string;
  address: string | null;
  contact_info: string | null;
  status: 'active' | 'temporarily_closed' | 'closed';
  is_default: boolean;
  created_at: string;
}

export function toWireBranch(row: BranchRow): WireBranch {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    contact_info: row.contact_info,
    status: row.status,
    is_default: row.is_default,
    created_at: row.created_at.toISOString(),
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
  user_status: z.enum(['pending_approval', 'active', 'suspended', 'rejected', 'disabled']),
  role_id: z.number().int(),
  role_name: z.string(),
  valid_from: z.string(),
});

export interface WireBranchStaffMember {
  assignment_id: number;
  user_id: number;
  full_name: string;
  email: string;
  user_status: 'pending_approval' | 'active' | 'suspended' | 'rejected' | 'disabled';
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
    is_default: z.coerce.boolean().optional(),
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
