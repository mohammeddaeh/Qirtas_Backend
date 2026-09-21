import { db } from '../../../core/db/client.js';
import type {
  SecurityEvent,
  SecurityEventSink,
} from '../../../core/auth/ports/security-event-sink.js';
import { customerActivityLogTable } from '../schemas/customers.schema.js';

/**
 * Sends the engine's events for the customer realm to `customer_activity_log`.
 *
 * Staff events go to `audit_log_entries`; that table's `user_id` is an FK to
 * `users`, so a customer id could never be stored there safely. Same event
 * vocabulary, different home.
 */
class CustomerActivitySink implements SecurityEventSink {
  async record(event: SecurityEvent): Promise<void> {
    await db.insert(customerActivityLogTable).values({
      customer_id: event.accountId,
      action: event.event,
      email: event.email ?? null,
      details: event.details ? JSON.stringify(event.details) : null,
      ip_address: event.ipAddress ?? null,
      device_info: event.deviceInfo ?? null,
    });
  }
}

export const customerActivitySink = new CustomerActivitySink();
