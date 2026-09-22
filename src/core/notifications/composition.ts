import { env } from '../config/env.js';
import { logger } from '../logger/logger.js';
import { setPushSender, type PushSender } from './ports/push-sender.js';
import { FcmPushSender, loadServiceAccount } from './adapters/fcm-push-sender.js';
import { LogPushSender } from './adapters/log-push-sender.js';

/**
 * Wires the push provider. Called once from `buildApp()`.
 *
 * With `FCM_SERVICE_ACCOUNT_PATH` set the real FCM sender is used; without it
 * the log sender, so a fresh checkout works before Firebase exists. A path that
 * is set but unreadable fails **loudly at boot** — silently falling back to the
 * log sender would mean production "sends" notifications that go nowhere.
 */
export function configureNotifications(override?: PushSender): void {
  if (override) return setPushSender(override);
  if (!env.FCM_SERVICE_ACCOUNT_PATH) {
    logger.warn('FCM_SERVICE_ACCOUNT_PATH not set — push notifications are logged, not delivered.');
    return setPushSender(new LogPushSender());
  }
  setPushSender(new FcmPushSender(loadServiceAccount(env.FCM_SERVICE_ACCOUNT_PATH)));
}
