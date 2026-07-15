import { z } from 'zod';
import type { AuditLogEntryRow } from '../schemas/audit-log-entries.schema.js';

/** Mirrors WireAuditLogEntry below for OpenAPI doc generation only — see users.dto.ts for the pattern. */
export const auditLogEntryResponseSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  action: z.string(),
  target_entity: z.string(),
  previous_value: z.unknown(),
  new_value: z.unknown(),
  ip_address: z.string().nullable(),
  device_info: z.string().nullable(),
  performed_by_role: z.string().nullable(),
  branch_context: z.number().int().nullable(),
  created_at: z.string(),
});

export interface WireAuditLogEntry {
  id: number;
  user_id: number;
  action: string;
  target_entity: string;
  previous_value: unknown;
  new_value: unknown;
  ip_address: string | null;
  device_info: string | null;
  performed_by_role: string | null;
  branch_context: number | null;
  created_at: string;
}

export function toWireAuditLogEntry(row: AuditLogEntryRow): WireAuditLogEntry {
  return {
    id: row.id,
    user_id: row.user_id,
    action: row.action,
    target_entity: row.target_entity,
    previous_value: row.previous_value,
    new_value: row.new_value,
    ip_address: row.ip_address,
    device_info: row.device_info,
    performed_by_role: row.performed_by_role,
    branch_context: row.branch_context,
    created_at: row.created_at.toISOString(),
  };
}

export const auditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(15),
  user_id: z.coerce.number().int().positive().optional(),
  target_entity: z.string().trim().min(1).max(150).optional(),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
