import { ApiError } from '../http/api-error.js';

/**
 * `401 session_revoked` with `data.revoke_reason` — the one 401 the client
 * reads a cause from (see `session_tombstones`). Thrown by the `auth`
 * middleware and by `POST /auth/refresh`, which resolves the token itself:
 * the same revoked token must not get two different answers.
 */
export function sessionRevokedError(revokeReason: string | undefined): ApiError {
  return new ApiError(
    401,
    'This session was ended',
    undefined,
    undefined,
    { revoke_reason: revokeReason ?? 'signed_out_elsewhere' },
    'session_revoked',
  );
}
