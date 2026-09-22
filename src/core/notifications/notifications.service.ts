import { logger } from '../logger/logger.js';
import { isSupportedLang, type Lang } from '../i18n/messages.js';
import { getRealm, type RealmId } from '../auth/realm.js';
import { emailSender } from '../auth/ports/email-sender.js';
import * as tokensRepository from './repositories/push-tokens.repository.js';
import { pushSender } from './ports/push-sender.js';
import { NOTIFICATION, notificationText, type NotificationEvent, type NotificationParams } from './events.js';
import * as sessionsRepository from '../auth/repositories/sessions.repository.js';

/**
 * Tells a person about a decision on their account: **push to every device AND
 * an email, always in parallel**.
 *
 * ## Why both channels, not "push, falling back to email"
 *
 * A push that "succeeded" only means FCM accepted it — not that a phone was on,
 * the app was installed, or notifications were allowed. Treating acceptance as
 * delivery would mean a person with notifications switched off is never told
 * their wholesale request was answered. Email is the record that arrives.
 *
 * ## Why this never throws
 *
 * The caller has just made a real decision (approved, suspended) inside its own
 * request. A push provider being down must not turn that into a 500 for the
 * admin who did nothing wrong, so every failure here is logged and swallowed.
 * Callers do not `await` it for the same reason: the response should not wait on
 * Google.
 */

export interface NotifyParams extends NotificationParams {
  realm: RealmId;
  accountId: number;
  /** The account's address — the always-delivered channel. */
  email: string;
  event: NotificationEvent;
  /** The account's own language when known (customers store one); devices may override for their push. */
  lang?: string | null | undefined;
}

function pickLang(candidate: string | null | undefined): Lang {
  return isSupportedLang(candidate ?? '') ? (candidate as Lang) : 'ar';
}

export function notify(params: NotifyParams): void {
  void deliver(params).catch((error: unknown) => {
    logger.warn(
      { event: params.event, err: error instanceof Error ? error.message : 'unknown' },
      'notification failed',
    );
  });
}

async function deliver(params: NotifyParams): Promise<void> {
  await Promise.allSettled([sendPushes(params), sendEmail(params)]);
}

/**
 * Whether a device still speaks for the account: the session that registered
 * it is alive.
 *
 * A signed-out device used to keep receiving the account's pushes. A deliberate
 * sign-out unregisters the device first; a session that *ended* — timed out,
 * revoked from another device, reset with the password, refused on suspension —
 * left the device registered, so whoever held the phone next read that
 * account's decisions and their reasons.
 *
 * Checked at send time rather than by deleting rows at each place a session
 * ends: those places are many (expiry is lazy, revocation, reset, the status
 * refusal in `auth` middleware), and one forgotten would bring the leak back.
 */
async function sessionIsLive(realm: RealmId, sessionId: number | null): Promise<boolean> {
  if (sessionId === null) return true;
  const session = await sessionsRepository.findById(getRealm(realm), sessionId);
  return session !== undefined && session.expires_at > new Date();
}

/**
 * The one event a device receives after its session ended: a suspended
 * person's session is deleted on their next request, and this is how their
 * phone learns they may sign in again.
 */
const DELIVERED_WITHOUT_SESSION: ReadonlySet<NotificationEvent> = new Set([
  NOTIFICATION.accountReactivated,
]);

async function sendPushes(params: NotifyParams): Promise<void> {
  const registered = await tokensRepository.findByAccount(params.realm, params.accountId);
  const devices = DELIVERED_WITHOUT_SESSION.has(params.event)
    ? registered
    : (
        await Promise.all(
          registered.map(async (d) => ((await sessionIsLive(params.realm, d.session_id)) ? d : null)),
        )
      ).filter((d): d is (typeof registered)[number] => d !== null);
  const dead: string[] = [];
  await Promise.all(
    devices.map(async (device) => {
      // The device's own language wins: it is what the person is reading right now.
      const text = notificationText(
        params.event,
        pickLang(device.language ?? params.lang),
        params,
      );
      const outcome = await pushSender().send(device.token, {
        ...text,
        data: { event: params.event },
      });
      if (outcome === 'invalid') dead.push(device.token);
    }),
  );
  await tokensRepository.removeMany(dead);
}

async function sendEmail(params: NotifyParams): Promise<void> {
  const text = notificationText(params.event, pickLang(params.lang), params);
  const result = await emailSender().send({
    to: params.email,
    kind: 'notification',
    subject: text.title,
    text: `${text.title}\n\n${text.body}\n`,
  });
  if (!result.ok) {
    logger.warn({ event: params.event, reason: result.errorCode }, 'notification email failed');
  }
}

export async function registerDevice(params: {
  realm: RealmId;
  accountId: number;
  token: string;
  platform: string;
  language: string | null;
  /** `req.session.id` — which session speaks for this device (see [sessionIsLive]). */
  sessionId: number | null;
}): Promise<void> {
  await tokensRepository.upsert(params);
}

export async function unregisterDevice(
  realm: RealmId,
  accountId: number,
  token: string,
): Promise<void> {
  await tokensRepository.removeOwned(realm, accountId, token);
}
