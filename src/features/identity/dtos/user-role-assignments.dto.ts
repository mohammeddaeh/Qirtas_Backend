import { z } from 'zod';
import type { UserRoleAssignmentRow } from '../schemas/user-role-assignments.schema.js';

/** Mirrors WireUserRoleAssignment below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const userRoleAssignmentResponseSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  role_id: z.number().int(),
  /** Present on list responses; absent on the create/transfer echo. */
  role_name: z.string().optional(),
  /** What the role was called while this posting ran — ended postings only. */
  role_name_then: z.string().nullable().optional(),
  branch_id: z.number().int().nullable(),
  /** `null` = unrestricted (every branch), not "unknown". */
  branch_name: z.string().nullable().optional(),
  /** The branch's own status — `null` when unrestricted (no branch to have one). */
  branch_status: z.enum(['active', 'temporarily_closed', 'closed']).nullable().optional(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  created_at: z.string(),
});

export interface WireUserRoleAssignment {
  id: number;
  user_id: number;
  role_id: number;
  role_name?: string;
  /**
   * The role's name AT THE TIME this posting ran, when it differs from
   * `role_name` today.
   *
   * Sent only for ended postings, and only when a rename actually happened in
   * between. `role_name` is resolved by a live join, so renaming "كاشير" to
   * "موظف مبيعات" retroactively rewrites every closed posting that ever ran
   * under the old name — the record quietly restating its own past. This field
   * is what lets the client say "كاشير (تُسمّى اليوم موظف مبيعات)" instead.
   *
   * Reconstructed from the audit log rather than snapshotted onto the row, so
   * there is still exactly one place a name lives. See `audit.service.resolveNameAt`.
   */
  role_name_then?: string | null;
  branch_id: number | null;
  branch_name?: string | null;
  /**
   * Status of the branch this post sits in — `null` when unrestricted.
   *
   * Sent because an assignment is not readable without it: "works at فرع
   * طرطوس" reads as active employment even after that branch is shut, and the
   * client has no other way to know. The branch row is already joined for the
   * name, so this costs nothing.
   */
  branch_status?: 'active' | 'temporarily_closed' | 'closed' | null;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}

/** List variant — carries the joined display names alongside the ids. */
export function toWireUserRoleAssignmentWithNames(row: {
  id: number;
  user_id: number;
  role_id: number;
  role_name: string;
  branch_id: number | null;
  branch_name: string | null;
  branch_status: 'active' | 'temporarily_closed' | 'closed' | null;
  valid_from: Date;
  valid_to: Date | null;
  created_at: Date;
}): WireUserRoleAssignment {
  return {
    id: row.id,
    user_id: row.user_id,
    role_id: row.role_id,
    role_name: row.role_name,
    branch_id: row.branch_id,
    branch_name: row.branch_name,
    branch_status: row.branch_status,
    valid_from: row.valid_from.toISOString(),
    valid_to: row.valid_to ? row.valid_to.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

export function toWireUserRoleAssignment(row: UserRoleAssignmentRow): WireUserRoleAssignment {
  return {
    id: row.id,
    user_id: row.user_id,
    role_id: row.role_id,
    branch_id: row.branch_id,
    valid_from: row.valid_from.toISOString(),
    valid_to: row.valid_to ? row.valid_to.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

export const createAssignmentBodySchema = z.object({
  role_id: z.coerce.number().int().positive(),
  branch_id: z.coerce.number().int().positive().nullable().optional(),
  valid_from: z.coerce.date().optional(),
  valid_to: z.coerce.date().nullable().optional(),
});
export type CreateAssignmentBody = z.infer<typeof createAssignmentBodySchema>;

/** Transfer closes the current assignment and opens a new one atomically (never mutates branch_id in place). */
export const transferAssignmentBodySchema = z.object({
  new_role_id: z.coerce.number().int().positive(),
  new_branch_id: z.coerce.number().int().positive().nullable(),
  effective_at: z.coerce.date().optional(),
});
export type TransferAssignmentBody = z.infer<typeof transferAssignmentBodySchema>;

export const assignmentIdParamsSchema = z.object({
  assignmentId: z.coerce.number().int().positive(),
});

export const userIdParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
});
