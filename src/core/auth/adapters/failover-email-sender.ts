import { logger } from '../../logger/logger.js';
import type {
  EmailDeliveryResult,
  EmailMessage,
  EmailSender,
} from '../ports/email-sender.js';

/**
 * Tries mail accounts in order until one accepts the message.
 *
 * ## Why this exists
 *
 * The organisation mail server can be down, blocked, or refuse a recipient — and
 * a verification code that never arrives is a customer who never signs up, with
 * nothing on screen saying why. A second account (Gmail, a relay) behind the
 * first turns "the code did not arrive" into "the code came from the other
 * server".
 *
 * ## Why every failure moves on, `rejected` included
 *
 * "Rejected" from one server is often *that server's policy* (an organisation
 * relay that refuses external recipients), not a bad address — the next account
 * may accept the same message. The cost of trying is one more connection; the
 * cost of not trying is a lost code.
 *
 * ## What stays true of the port
 *
 * Still never throws, and still returns one outcome. The last failure is what
 * comes back when every account refuses, so the caller's `errorCode` describes
 * the final attempt rather than an arbitrary one.
 */
export interface NamedSender {
  name: string;
  sender: EmailSender;
}

export class FailoverEmailSender implements EmailSender {
  constructor(private readonly chain: NamedSender[]) {
    if (chain.length === 0) throw new Error('FailoverEmailSender needs at least one sender.');
  }

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    let last: EmailDeliveryResult = { ok: false, errorCode: 'no_transport' };

    for (const [index, { name, sender }] of this.chain.entries()) {
      last = await sender.send(message);
      if (last.ok) {
        // Worth a line: a fallback quietly carrying all the traffic means the
        // primary has been broken for a while and nobody has noticed.
        if (index > 0) {
          logger.warn(
            { account: name, kind: message.kind },
            'Email delivered by a FALLBACK account — the primary failed.',
          );
        }
        return last;
      }
    }

    logger.error(
      { kind: message.kind, attempts: this.chain.length },
      'Every mail account failed — the recipient did not receive this message.',
    );
    return last;
  }
}
