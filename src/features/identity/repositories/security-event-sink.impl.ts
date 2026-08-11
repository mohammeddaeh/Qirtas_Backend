import type { SecurityEvent, SecurityEventSink } from '../../../core/auth/ports/security-event-sink.js';
import * as auditLogRepository from './audit-log-entries.repository.js';

/**
 * Sends the authentication engine's security events to Qirtas's existing audit
 * log.
 *
 * ## Why an adapter and not a second table
 *
 * `audit_log_entries` already answers "who did what to this record, and when",
 * already has the indexes for it, and is already read by
 * `EntityHistorySection` on every detail screen. A parallel `security_events`
 * table would be a second place the past lives — and two places disagree the
 * first time one is written and the other is not. So a failed sign-in lands in
 * the same log as a role change, filterable by the same `target_entity`.
 *
 * ## What is deliberately dropped
 *
 * `branch_context` and `performed_by_role` stay null. Both are Qirtas business
 * concepts and neither is knowable at sign-in time — the session that would
 * carry them is being created by the very event being recorded. Writing a
 * guess would be worse than writing nothing.
 *
 * ## Why `user_id` can be null here
 *
 * A failed sign-in against an unregistered address has no actor by definition,
 * and that is the single most important event this sink carries: it is what a
 * brute-force attempt looks like. The column was `NOT NULL`, which meant the
 * one event worth alerting on could not be stored at all. It is nullable as of
 * the migration that introduced this file.
 */
class AuditLogSecurityEventSink implements SecurityEventSink {
  async record(event: SecurityEvent): Promise<void> {
    await auditLogRepository.insert({
      user_id: event.accountId,
      action: event.event,
      // Falls back to the attempted address when no account is known, so a
      // string of failures against one address groups under one target instead
      // of scattering across untargeted rows.
      target_entity:
        event.accountId !== null
          ? `user:${event.accountId}`
          : `email:${event.email ?? 'unknown'}`,
      // Authentication events describe something that happened, not a field
      // that changed — there is no "before" to record, and inventing one would
      // make the diff columns lie.
      previous_value: null,
      new_value: event.details ?? null,
      ip_address: event.ipAddress ?? null,
      device_info: event.deviceInfo ?? null,
      performed_by_role: null,
      branch_context: null,
    });
  }
}

export const auditLogSecurityEventSink = new AuditLogSecurityEventSink();
