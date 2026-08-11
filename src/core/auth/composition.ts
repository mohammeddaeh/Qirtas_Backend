import { env } from '../config/env.js';
import { logger } from '../logger/logger.js';
import { setEmailSender, type EmailSender } from './ports/email-sender.js';
import { setAccountStore, type AccountStore } from './ports/account-store.js';
import { setSecurityEventSink, type SecurityEventSink } from './ports/security-event-sink.js';
import { registerAuthProvider } from './ports/auth-provider.js';
import { localAuthProvider } from './providers/local-auth.provider.js';
import { SmtpEmailSender } from './adapters/smtp-email-sender.js';
import { LogEmailSender } from './adapters/log-email-sender.js';
import * as sessionService from './services/session.service.js';

/**
 * Wires the authentication engine to one application's implementations.
 *
 * Called once from `buildApp()`, before any route is mounted. Everything the
 * engine needs from the outside world passes through this function — which
 * means the complete list of what an application must supply is four
 * parameters, and adding a fifth would be visible as a signature change rather
 * than as a runtime failure somewhere deep in a request.
 */

export interface AuthComposition {
  accountStore: AccountStore;
  securityEventSink?: SecurityEventSink;
  /** Overrides transport selection entirely — used by tests to capture mail instead of sending it. */
  emailSender?: EmailSender;
}

const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function configureAuth(composition: AuthComposition): void {
  setAccountStore(composition.accountStore);

  if (composition.securityEventSink) {
    setSecurityEventSink(composition.securityEventSink);
  }

  setEmailSender(composition.emailSender ?? selectEmailSender());

  // Password sign-in is always available. A deployment offering only external
  // identity providers would omit this line — but it would also need a way for
  // an admin to get in when the provider is down, so the default is to have it.
  registerAuthProvider(localAuthProvider);

  startSessionSweep();
}

/**
 * Picks the mail transport.
 *
 * `auto` — the default — chooses SMTP when a host is configured and the log
 * adapter otherwise. That gives a laptop a working flow with zero mail setup,
 * while production without SMTP fails *loudly* rather than quietly writing
 * verification codes into a log file (see LogEmailSender, which refuses to do
 * so and says why).
 */
function selectEmailSender(): EmailSender {
  const useSmtp =
    env.MAIL_TRANSPORT === 'smtp' ||
    (env.MAIL_TRANSPORT === 'auto' && env.SMTP_HOST.length > 0);

  if (useSmtp) {
    if (env.SMTP_HOST.length === 0) {
      throw new Error('MAIL_TRANSPORT=smtp requires SMTP_HOST to be set.');
    }
    logger.info({ host: env.SMTP_HOST, port: env.SMTP_PORT }, 'Mail transport: SMTP');
    return new SmtpEmailSender();
  }

  if (env.NODE_ENV === 'production') {
    // A warning at boot, not an exception: refusing to start would take an
    // otherwise healthy API down over a feature most of it does not use. The
    // adapter itself withholds every code in production, so nothing leaks
    // while this is unresolved.
    logger.error(
      'No mail transport configured (SMTP_HOST is empty). Email verification ' +
        'and password reset codes will NOT be delivered. Set SMTP_HOST.',
    );
  } else {
    logger.warn('Mail transport: log (development only — no mail will be sent)');
  }
  return new LogEmailSender();
}

/**
 * Removes sessions past their hard deadline.
 *
 * The per-request path already deletes any dead session that is *presented*;
 * this catches the ones nobody comes back to, which would otherwise accumulate
 * for the lifetime of the deployment. `unref()` so the timer never keeps the
 * process alive during a graceful shutdown.
 */
function startSessionSweep(): void {
  setInterval(() => {
    void sessionService.purgeExpired().catch((err: unknown) => {
      logger.warn({ err }, 'Session sweep failed — will retry on the next interval');
    });
  }, SESSION_SWEEP_INTERVAL_MS).unref();
}
