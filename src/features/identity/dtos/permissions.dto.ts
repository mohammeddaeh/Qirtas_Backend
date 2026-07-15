import { z } from 'zod';
import type { PermissionRow } from '../schemas/permissions.schema.js';

/** Mirrors WirePermission below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const permissionResponseSchema = z.object({
  key: z.string(),
  module: z.string(),
  is_sensitive: z.boolean(),
  created_at: z.string(),
});

export interface WirePermission {
  key: string;
  module: string;
  is_sensitive: boolean;
  created_at: string;
}

export function toWirePermission(row: PermissionRow): WirePermission {
  return {
    key: row.key,
    module: row.module,
    is_sensitive: row.is_sensitive,
    created_at: row.created_at.toISOString(),
  };
}

/** `module.action`, module segment always plural (users_roles.md — Naming Convention, 2026-07-09). */
export const permissionKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
    'Permission key must follow the "module.action" convention',
  );

export const createPermissionBodySchema = z.object({
  key: permissionKeySchema,
  module: z.string().trim().min(1).max(60),
  is_sensitive: z.boolean().default(false),
});
export type CreatePermissionBody = z.infer<typeof createPermissionBodySchema>;
