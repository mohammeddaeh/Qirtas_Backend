import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { logger } from '../../logger/logger.js';
import type { PushOutcome, PushPayload, PushSender } from '../ports/push-sender.js';

/**
 * Firebase Cloud Messaging over the HTTP v1 API — no SDK dependency.
 *
 * `firebase-admin` is ~30 MB of transitive packages for two HTTP calls: one to
 * trade a signed JWT for an access token, one to send. Both are here in ~80
 * lines with `node:crypto`, and every moving part is visible.
 *
 * ## The credential
 *
 * A Google **service account** JSON, read from the path in
 * `FCM_SERVICE_ACCOUNT_PATH`. It can send notifications to every device of the
 * app, so it lives outside the repository and outside the database; this file
 * only ever reads it and never logs any part of it.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function loadServiceAccount(path: string): ServiceAccount {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceAccount>;
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error('FCM service account file is missing project_id / client_email / private_key');
  }
  return parsed as ServiceAccount;
}

export class FcmPushSender implements PushSender {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly account: ServiceAccount) {}

  private signJwt(now: number): string {
    const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key);
    return `${unsigned}.${signature.toString('base64url')}`;
  }

  /** Cached until a minute before expiry — one token exchange serves many sends. */
  private async getAccessToken(): Promise<string> {
    const nowMs = Date.now();
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > nowMs) {
      return this.accessToken.value;
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.signJwt(Math.floor(nowMs / 1000)),
      }),
    });
    if (!res.ok) throw new Error(`FCM token exchange failed (${res.status})`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: json.access_token, expiresAt: nowMs + json.expires_in * 1000 };
    return json.access_token;
  }

  async send(token: string, payload: PushPayload): Promise<PushOutcome> {
    try {
      const accessToken = await this.getAccessToken();
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: payload.title, body: payload.body },
              ...(payload.data ? { data: payload.data } : {}),
              android: { priority: 'HIGH' },
            },
          }),
        },
      );
      if (res.ok) return 'ok';
      // 404 UNREGISTERED = uninstalled/expired; 400 with INVALID_ARGUMENT names a
      // malformed token. Both mean "never send here again"; everything else
      // (5xx, quota, auth) is the provider's problem and the token stays.
      if (res.status === 404 || res.status === 400) return 'invalid';
      logger.warn({ status: res.status }, 'FCM send refused');
      return 'failed';
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'FCM send failed');
      return 'failed';
    }
  }
}
