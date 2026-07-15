import { z } from 'zod';
import type { RoleRow } from '../schemas/roles.schema.js';
import {
  permissionKeySchema,
  permissionResponseSchema,
  type WirePermission,
} from './permissions.dto.js';

/** Mirrors WireRole below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const roleResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  category: z.enum(['system', 'management', 'operational', 'financial', 'external']),
  level: z.number().int().nullable(),
  is_system_default: z.boolean(),
  is_active: z.boolean(),
  created_at: z.string(),
  permissions: z.array(permissionResponseSchema).optional(),
});

export interface WireRole {
  id: number;
  name: string;
  category: 'system' | 'management' | 'operational' | 'financial' | 'external';
  level: number | null;
  is_system_default: boolean;
  is_active: boolean;
  created_at: string;
  permissions?: WirePermission[];
}

export function toWireRole(row: RoleRow, permissions?: WirePermission[]): WireRole {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    level: row.level,
    is_system_default: row.is_system_default,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    ...(permissions ? { permissions } : {}),
  };
}

export const roleIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const createRoleBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  category: z.enum(['system', 'management', 'operational', 'financial', 'external']),
  permission_keys: z.array(permissionKeySchema).default([]),
  /** Optional source role to clone permissions from as the starting point. */
  clone_from_role_id: z.coerce.number().int().positive().optional(),
  /** Explicit override to proceed despite an exact-permission-set match warning. */
  force: z.boolean().default(false),
});
export type CreateRoleBody = z.infer<typeof createRoleBodySchema>;

export const updateRolePermissionsBodySchema = z.object({
  permission_keys: z.array(permissionKeySchema),
});
export type UpdateRolePermissionsBody = z.infer<typeof updateRolePermissionsBodySchema>;

/** `level` edits are Super Admin-only and go through a dedicated endpoint (see users_roles.md). */
export const updateRoleLevelBodySchema = z.object({
  level: z.number().int().min(0),
});
export type UpdateRoleLevelBody = z.infer<typeof updateRoleLevelBodySchema>;
