import { logger } from '../../logger/logger.js';
import type { PushOutcome, PushPayload, PushSender } from '../ports/push-sender.js';

/**
 * Development stand-in used until Firebase credentials exist (no
 * `FCM_SERVICE_ACCOUNT_PATH`): writes what **would** have been pushed. The token
 * is truncated — it is a delivery credential for one device.
 */
export class LogPushSender implements PushSender {
  async send(token: string, payload: PushPayload): Promise<PushOutcome> {
    logger.info(
      { to: `${token.slice(0, 8)}…`, title: payload.title, body: payload.body, data: payload.data },
      'push (log transport — not delivered)',
    );
    return 'ok';
  }
}
