import { z } from 'zod';
import {
  registry,
  successEnvelope,
  commonErrorResponses,
  unauthorizedResponse,
} from '../../core/openapi/registry.js';
import {
  changePasswordBodySchema,
  forgotPasswordBodySchema,
  resetPasswordBodySchema,
  sessionIdParamsSchema,
  verifyEmailBodySchema,
  sessionResponseSchema,
  refreshResponseSchema,
} from './dtos/auth.dto.js';

/**
 * OpenAPI for `/api/v1/auth/*`.
 *
 * Login and logout are documented in `features/identity/users.openapi.ts`
 * alongside the routes that serve them — see `features/auth/routes/auth.routes.ts`
 * for why those two stayed on `/users`.
 */
const tags = ['Authentication & Sessions'];
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/refresh',
  tags,
  summary: 'Extend the calling session, rotating its token when old enough',
  description:
    'Takes the current Bearer token and returns one to store. `rotated=false` means the token was still young and is returned unchanged — the client saves whatever it receives either way. A session ended by idle timeout, absolute expiry or revocation answers 401 and is never revived. This endpoint is deliberately NOT behind requireAuth: an expiring session is exactly what calls it.',
  responses: {
    200: { description: 'The token to use from now on', ...jsonBody(successEnvelope(refreshResponseSchema)) },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/auth/sessions',
  tags,
  summary: "The caller's own signed-in devices",
  description:
    'No permission required — these are the caller\'s sessions, not anyone else\'s. The token itself is never returned: only its digest is stored, and only the holder ever had the plaintext. `is_current` marks the session making this request.',
  responses: {
    200: { description: 'Live sessions, most recently active first', ...jsonBody(successEnvelope(z.array(sessionResponseSchema))) },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/auth/sessions/{id}',
  tags,
  summary: 'End one of my sessions',
  description:
    "A session that does not exist and one belonging to somebody else both answer 404, so iterating ids cannot reveal which are live.",
  request: { params: sessionIdParamsSchema },
  responses: {
    200: { description: 'Session revoked', ...jsonBody(successEnvelope(z.null())) },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/sessions/revoke-others',
  tags,
  summary: 'Sign out my other devices',
  description:
    'Spares the session issuing the command — signing yourself out while securing your account reads as a malfunction.',
  responses: {
    200: {
      description: 'How many sessions were ended',
      ...jsonBody(successEnvelope(z.object({ sessions_revoked: z.number().int() }))),
    },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/verify-email',
  tags,
  summary: 'Prove the account owns its email address',
  description:
    'Authenticated: an unverified account receives a real session that unlocks nothing (it holds no role assignment), precisely so it can reach this endpoint after a reinstall. On success the account advances from `pending_verification` to `pending_approval` and enters the admin review queue — which is what keeps that queue un-floodable by addresses nobody owns. Wrong / expired / already-spent / out-of-attempts all answer one 422 with `message_key=verification_code_invalid`, so nobody can probe which accounts have a verification in flight.',
  request: { body: jsonBody(verifyEmailBodySchema) },
  responses: {
    200: {
      description:
        "The account's NEW state — so the client never re-derives the transition locally",
      ...jsonBody(
        successEnvelope(
          z.object({
            status: z.string(),
            email_verified: z.boolean(),
            email_verified_at: z.string().nullable(),
          }),
        ),
      ),
    },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/resend-verification',
  tags,
  summary: 'Send a new verification code',
  description:
    'Reports a cooldown honestly (429, `verification_resend_cooldown`) because this endpoint is authenticated and therefore leaks nothing about who is registered — unlike `/auth/forgot-password`, which must stay silent for exactly the opposite reason. Issuing a new code invalidates any previous one, so many resends do not multiply the attempt budget against an account.',
  responses: {
    200: { description: 'Verification code sent', ...jsonBody(successEnvelope(z.null())) },
    409: { description: 'Already verified, or verification is disabled on this server' },
    429: { description: 'A code was sent too recently' },
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/forgot-password',
  tags,
  summary: 'Request a password reset code',
  description:
    'ALWAYS succeeds, whether or not the address is registered, and whether or not the account is usable. A different answer would make this a membership oracle: anyone could test addresses one at a time and learn who has an account here. A resend cooldown is likewise swallowed rather than reported, since "please wait" would confirm a code was recently sent, which confirms the account exists.',
  request: { body: jsonBody(forgotPasswordBodySchema) },
  responses: {
    200: { description: 'Accepted (reveals nothing about the address)', ...jsonBody(successEnvelope(z.null())) },
    429: { description: 'Rate limited by source IP' },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/reset-password',
  tags,
  summary: 'Spend a reset code and set a new password',
  description:
    'Ends EVERY session for the account on success — the usual reason someone resets a password is that somebody else knows it, so leaving the other party signed in would mean the reset changed nothing for exactly the person it was aimed at. Accepts the legacy field name `token` as well as `code`; send `code`.',
  request: { body: jsonBody(resetPasswordBodySchema) },
  responses: {
    // 422 comes from commonErrorResponses. It is the answer to an invalid,
    // expired, already-used OR out-of-attempts code — deliberately
    // indistinguishable, carrying `message_key=reset_code_invalid` in all four
    // cases so nobody can probe which addresses have a reset in flight.
    200: { description: 'Password updated; all sessions ended', ...jsonBody(successEnvelope(z.null())) },
    429: { description: 'Rate limited by source IP' },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/change-password',
  tags,
  summary: 'Change my own password',
  description:
    'A wrong `current_password` answers 422, NOT 401. This request is authenticated, and every client treats 401 as "your session is invalid" and signs the user out — so 401 for a mistyped field would eject someone from the app over a typo. Other sessions survive unless `revoke_other_sessions` is true; the caller\'s own session always survives.',
  request: { body: jsonBody(changePasswordBodySchema) },
  responses: {
    200: {
      description: 'Password changed',
      ...jsonBody(successEnvelope(z.object({ sessions_revoked: z.number().int() }))),
    },
    // 422 comes from commonErrorResponses — it covers both a wrong
    // `current_password` (`message_key=current_password_wrong`) and a new
    // password that fails the policy.
    ...unauthorizedResponse,
    ...commonErrorResponses,
  },
});
