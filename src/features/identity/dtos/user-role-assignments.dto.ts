import { z } from 'zod';
import type { UserRoleAssignmentRow } from '../schemas/user-role-assignments.schema.js';

/** Mirrors WireUserRoleAssignment below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const userRoleAssignmentResponseSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  role_id: z.number().int(),
  branch_id: z.number().int().nullable(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  created_at: z.string(),
});

export interface WireUserRoleAssignment {
  id: number;
  user_id: number;
  role_id: number;
  branch_id: number | null;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
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
