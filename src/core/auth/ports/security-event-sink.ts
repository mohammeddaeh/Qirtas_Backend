/**
 * Where authentication events go to be remembered.
 *
 * ## Why a port rather than calling the audit service directly
 *
 * `auditService.record()` lives in `features/identity` and writes to
 * `audit_log_entries`, a table with a `branch_context` column and a
 * `performed_by_role` column — both of which are Qirtas business concepts.
 * `core/auth` cannot depend on that without dragging identity into every app
 * that reuses this engine.
 *
 * So the engine emits; the application decides where it lands. Qirtas wires
 * this to the existing audit log (nothing new to build, one adapter). A template
 * consumer with no audit table wires it to the logger, or to nothing.
 *
 * ## Why the actor is nullable
 *
 * The single most important authentication event — a failed sign-in — has no
 * authenticated actor by definition. `audit_log_entries.user_id` was `NOT NULL`,
 * which meant a failed login against an unknown address **could not be recorded
 * at all**: the one event a brute-force attempt produces was the one event the
 * schema refused. That column is made nullable in the same change as this file.
 *
 * ## What must never appear in an event
 *
 * Passwords, password hashes, session tokens, verification codes, reset codes.
 * `details` is written to durable storage and read by humans; a token in an
 * audit row is a token in a backup, forever. The emitting services pass
 * identifiers (`session_id`, `email`) and never the secrets themselves.
 */

import type { RealmId } from '../realm.js';

/**
 * The catalogue of authentication events.
 *
 * One place, so the set is discoverable and a typo cannot invent a parallel
 * event name no query will ever find — the same convention (and the same
 * reason) as `features/identity/services/audit-actions.ts`.
 */
export const AUTH_EVENT = {
  loginSuccess: 'auth.login.success',
  /** No actor: the account may not exist. See the note above on nullability. */
  loginFailed: 'auth.login.failed',
  /** Credentials were correct but the application refused the sign-in (suspended, unverified, …). */
  loginRefused: 'auth.login.refused',
  logout: 'auth.logout',

  sessionRotated: 'auth.session.rotated',
  sessionRevoked: 'auth.session.revoked',
  /** Every session for one account ended at once — password reset, or "sign out everywhere". */
  sessionRevokedAll: 'auth.session.revoked_all',

  accountRegistered: 'auth.account.registered',
  /** A code was issued AND the transport accepted the message. Never recorded for a send that failed. */
  emailVerificationSent: 'auth.email.verification_sent',
  /**
   * A code was issued but the mail never left — the address is stranded with a
   * live code it cannot receive.
   *
   * Recorded as its own event rather than as a detail on the "sent" one because
   * the two demand opposite responses: nothing, versus look at the mail
   * configuration. `details.reason` carries an `EmailDeliveryFailure` code —
   * `rejected`, `auth`, `connection` — never the provider's own text, which can
   * name hosts and accounts.
   */
  emailVerificationSendFailed: 'auth.email.verification_send_failed',
  emailVerified: 'auth.email.verified',
  emailVerificationFailed: 'auth.email.verification_failed',

  passwordChanged: 'auth.password.changed',
  /** The reset code was issued AND the transport accepted the message. */
  passwordResetRequested: 'auth.password.reset_requested',
  /** Same distinction as `emailVerificationSendFailed`, for the reset flow. */
  passwordResetSendFailed: 'auth.password.reset_send_failed',
  passwordResetCompleted: 'auth.password.reset_completed',
  passwordResetFailed: 'auth.password.reset_failed',
} as const;

export type AuthEventName = (typeof AUTH_EVENT)[keyof typeof AUTH_EVENT];

export interface SecurityEvent {
  event: AuthEventName;
  /** Which population the event is about. `accountId` is only meaningful together with this: staff id 7 and customer id 7 are different people. */
  realm: RealmId;
  /** The account the event is ABOUT. Null when unknown — a failed login against an unregistered address. */
  accountId: number | null;
  /**
   * The address the attempt used, when relevant.
   *
   * Recorded even for unknown addresses: "someone tried to sign in as X 400
   * times" is the finding, and it is unavailable if only successful attempts
   * carry an identity.
   */
  email?: string | null;
  ipAddress?: string | null;
  deviceInfo?: string | null;
  /** Non-secret context — `{ session_id: 12 }`, `{ reason: 'expired' }`. Never a credential. */
  details?: Record<string, unknown>;
}

export interface SecurityEventSink {
  record(event: SecurityEvent): Promise<void>;
}

/**
 * Default sink: discards everything.
 *
 * Chosen over throwing so that an application which has not wired a sink still
 * *works* — authentication must not fail because auditing is unconfigured. The
 * trade-off is a silent gap, which is why composition wires a real sink and the
 * one-line omission is visible in `src/app.ts` rather than buried here.
 */
class NoopSecurityEventSink implements SecurityEventSink {
  async record(): Promise<void> {
    /* intentionally empty — see the class doc */
  }
}

let sink: SecurityEventSink = new NoopSecurityEventSink();

export function setSecurityEventSink(implementation: SecurityEventSink): void {
  sink = implementation;
}

/**
 * Records [event], swallowing any failure.
 *
 * Auditing must never turn a successful sign-in into a 500. A sink that is down
 * costs visibility; a sink that throws would cost availability, which is the
 * worse of the two and the easier one to cause.
 */
export async function recordSecurityEvent(event: SecurityEvent): Promise<void> {
  try {
    await sink.record(event);
  } catch {
    /* deliberately swallowed — see the doc above */
  }
}

/**
 * Sends each event to the sink registered for its realm.
 *
 * A realm with no entry is dropped rather than failing — same stance as the
 * default sink: auditing must never break authentication.
 */
export function sinkByRealm(sinks: Partial<Record<RealmId, SecurityEventSink>>): SecurityEventSink {
  return {
    async record(event: SecurityEvent): Promise<void> {
      await sinks[event.realm]?.record(event);
    },
  };
}
