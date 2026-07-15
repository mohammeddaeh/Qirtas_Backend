import { z } from 'zod';
import type { OwnershipRow } from '../schemas/ownerships.schema.js';

/** Mirrors WireOwnership below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const ownershipResponseSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  percentage: z.number(),
  branch_scope: z.number().int().nullable(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  created_at: z.string(),
});

export interface WireOwnership {
  id: number;
  user_id: number;
  percentage: number;
  branch_scope: number | null;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}

export function toWireOwnership(row: OwnershipRow): WireOwnership {
  return {
    id: row.id,
    user_id: row.user_id,
    percentage: Number(row.percentage),
    branch_scope: row.branch_scope,
    valid_from: row.valid_from.toISOString(),
    valid_to: row.valid_to ? row.valid_to.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

export const createOwnershipBodySchema = z.object({
  user_id: z.coerce.number().int().positive(),
  percentage: z.coerce.number().min(0.01).max(100),
  branch_scope: z.coerce.number().int().positive().nullable().optional(),
});
export type CreateOwnershipBody = z.infer<typeof createOwnershipBodySchema>;

export const listOwnershipsQuerySchema = z.object({
  branch_scope: z.coerce.number().int().positive().optional(),
});
export type ListOwnershipsQuery = z.infer<typeof listOwnershipsQuerySchema>;
