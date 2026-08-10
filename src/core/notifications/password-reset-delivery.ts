import { logger } from '../logger/logger.js';
import { env } from '../config/env.js';

/**
 * How a password-reset code reaches its owner.
 *
 * ── Why this is a port and not a `sendMail()` call ─────────────────────────
 * This project has **no mail infrastructure** — no nodemailer, no provider SDK,
 * no SMTP credentials. Writing the reset flow around a concrete mailer would
 * mean either adding all of that first, or leaving the endpoints unbuilt for
 * however long that takes.
 *
 * So delivery is a one-method interface. The flow is complete and correct
 * today; the day SMTP exists, one adapter is written and one line changes.
 */
export interface PasswordResetDelivery {
  /**
   * Deliver [code] to [email].
   *
   * Must not throw for an unknown address — the caller cannot tell the client
   * whether the address was registered (see `requestPasswordReset`), so a
   * failure here must not become a different HTTP response either.
   */
  send(email: string, code: string): Promise<void>;
}

/**
 * Development adapter: writes the code to the server log.
 *
 * **This is not a mail sender and must never run in production.** Reset codes
 * in a log file are reset codes readable by anyone with log access, which is a
 * larger group than "the account owner" in every deployment.
 *
 * The guard below is deliberately loud and unconditional rather than a comment
 * asking someone to remember: the failure mode of forgetting is silent, and
 * silent is exactly how a dev-only shortcut reaches production.
 */
export class LogPasswordResetDelivery implements PasswordResetDelivery {
  async send(email: string, code: string): Promise<void> {
    if (env.NODE_ENV === 'production') {
      logger.error(
        { email },
        'Password reset requested with no delivery adapter configured. ' +
          'The code was NOT sent and was NOT logged. Configure a real ' +
          'PasswordResetDelivery before serving this endpoint in production.',
      );
      return;
    }

    logger.warn(
      { email, code },
      'DEV ONLY — password reset code (no mailer configured; this line must ' +
        'never appear in a production log)',
    );
  }
}

/**
 * The active adapter.
 *
 * Swap this single line for a real implementation (`new SmtpPasswordResetDelivery(...)`)
 * and nothing else in the reset flow changes.
 */
export const passwordResetDelivery: PasswordResetDelivery =
  new LogPasswordResetDelivery();
