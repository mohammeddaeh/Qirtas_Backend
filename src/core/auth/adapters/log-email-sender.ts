import { logger } from '../../logger/logger.js';
import { env } from '../../config/env.js';
import {
  recipientDomain,
  type EmailDeliveryResult,
  type EmailMessage,
  type EmailSender,
} from '../ports/email-sender.js';

/**
 * Development transport: writes the message to the server log instead of
 * sending it.
 *
 * Exists so the whole authentication flow — register, verify, reset — is usable
 * on a laptop with no mail server, which is the difference between a flow that
 * can be developed and tested and one that is written blind and first exercised
 * in production.
 *
 * ## Why it refuses to run in production, loudly
 *
 * A verification code in a log file is a verification code readable by everyone
 * with log access, and that is always a larger group than "the account owner".
 * The failure mode of *forgetting* to configure a real transport is silent —
 * mail simply never arrives, users report "the code didn't come", and the codes
 * sit in the log the whole time. So this adapter treats production as an error
 * state: it logs the misconfiguration, withholds the body, and returns
 * successfully.
 *
 * Not throwing is deliberate and is the same rule the port states: a send
 * failure must not change the HTTP response, or the password-reset endpoint
 * would answer differently for registered and unregistered addresses and become
 * the membership oracle it is written to avoid.
 *
 * It reports `no_transport` rather than success, though, and the distinction is
 * the whole point: the caller learns that nothing was delivered without the
 * client learning anything at all. In development it reports `ok`, because
 * writing the code where the developer can read it *is* delivery here — the
 * verification e2e test reads codes out of exactly this line.
 */
export class LogEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    const context = {
      provider: 'log' as const,
      kind: message.kind,
      recipientDomain: recipientDomain(message.to),
    };

    if (env.NODE_ENV === 'production') {
      logger.error(
        context,
        'No mail transport is configured. This message was NOT sent and its ' +
          'body was NOT logged. Set SMTP_HOST (and credentials) before serving ' +
          'authentication endpoints in production.',
      );
      return { ok: false, errorCode: 'no_transport' };
    }

    // The full address and the body — including the code — are written here and
    // only here. That is the adapter's entire purpose and the reason the branch
    // above exists: this line is safe on a laptop and unacceptable anywhere else.
    logger.warn(
      { ...context, to: message.to, subject: message.subject, body: message.text },
      'DEV ONLY — email written to the log because no mail transport is ' +
        'configured. This line must never appear in a production log.',
    );
    return { ok: true };
  }
}
