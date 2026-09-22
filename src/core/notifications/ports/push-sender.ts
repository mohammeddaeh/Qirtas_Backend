/**
 * The one thing the notification engine needs from a push provider.
 *
 * A port, like `EmailSender`: the engine says "deliver this to this device" and
 * never learns whether that is FCM, APNs or a log line. The outcome is three-way
 * rather than boolean because the caller must act differently on each:
 * `invalid` = delete the token (the device is gone), `failed` = keep it (the
 * provider is down — the next event may succeed).
 */
export interface PushPayload {
  title: string;
  body: string;
  /** String-only, per FCM. Lets the app route a tap (`{event: 'wholesale_approved'}`). */
  data?: Record<string, string>;
}

export type PushOutcome = 'ok' | 'invalid' | 'failed';

export interface PushSender {
  send(token: string, payload: PushPayload): Promise<PushOutcome>;
}

let sender: PushSender | undefined;

export function setPushSender(implementation: PushSender): void {
  sender = implementation;
}

export function pushSender(): PushSender {
  if (!sender) {
    throw new Error('No PushSender configured. Call configureNotifications() during composition.');
  }
  return sender;
}
