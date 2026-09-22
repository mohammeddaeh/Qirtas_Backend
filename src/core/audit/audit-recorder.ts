import type { RequestActorContext } from '../http/require-actor.js';

/**
 * Writes one entry to the audit log — for features that are not `identity`.
 *
 * The log's table and writer belong to `features/identity/`, and a feature may
 * not import another feature. Without this port the catalog would either skip
 * auditing (the §C1 gap production_readiness.md closed: "who changed this
 * price?" with no answer) or keep a second log, and two logs disagree the
 * first time one is written and the other is not.
 *
 * `identity` supplies the implementation in `buildApp()`; every caller writes
 * to the same `audit_log_entries` rows and shows up in the same
 * `EntityHistorySection` on the client.
 */
export type AuditRecorder = (
  actor: RequestActorContext,
  action: string,
  targetEntity: string,
  previousValue: unknown,
  newValue: unknown,
) => Promise<void>;

let recorder: AuditRecorder | undefined;

export function setAuditRecorder(value: AuditRecorder): void {
  recorder = value;
}

/** Throws when unwired — a mutation that silently skipped its audit entry is worse than a failed request. */
export function recordAudit(
  actor: RequestActorContext,
  action: string,
  targetEntity: string,
  previousValue: unknown,
  newValue: unknown,
): Promise<void> {
  if (!recorder)
    throw new Error('Audit recorder not configured — call setAuditRecorder() in buildApp()');
  return recorder(actor, action, targetEntity, previousValue, newValue);
}
