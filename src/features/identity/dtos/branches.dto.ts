import { z } from 'zod';
import type { BranchRow } from '../schemas/branches.schema.js';

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

export const createBranchBodySchema = z.object({
  name: z.string().trim().min(1).max(150),
  address: z.string().trim().max(2000).optional(),
  contact_info: z.string().trim().max(500).optional(),
});
export type CreateBranchBody = z.infer<typeof createBranchBodySchema>;

export const updateBranchBodySchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  address: z.string().trim().max(2000).nullable().optional(),
  contact_info: z.string().trim().max(500).nullable().optional(),
  status: z.enum(['active', 'temporarily_closed', 'closed']).optional(),
});
export type UpdateBranchBody = z.infer<typeof updateBranchBodySchema>;
