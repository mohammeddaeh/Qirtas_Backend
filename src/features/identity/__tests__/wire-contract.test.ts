import { describe, expect, it } from 'vitest';
import {
  loginResponseSchema,
  currentUserResponseSchema,
  userResponseSchema,
} from '../dtos/users.dto.js';

/**
 * **The server half of the contract `qirtas_app` parses.**
 *
 * A JSON key is an agreement between two repositories and **nothing enforces
 * it**: `tsc` does not know a client exists, `dart analyze` reads a missing key
 * as `null`, and `HandleBodyResponse` on the Flutter side turns the resulting
 * throw into a generic `Failure`. The published failure mode is the worst one
 * this codebase collects — `200 OK` in the log, a real row in the database, and
 * "something went wrong" on the screen.
 *
 * That exact defect shipped in the template this project derives from: the
 * client read `data.user` while the server sent `data.account`, and sign-in
 * failed on **every** attempt with both pipelines green.
 *
 * What this file can do is make the **key names** a mechanically-checked fact
 * rather than an unstated agreement — so a rename fails here, and
 * `qirtas_app/test/wire_contract_test.dart` fails there, and both point at the
 * same word.
 *
 * The two suites are deliberately written against the same shapes. When a
 * payload changes, change both.
 */

/** A wire user as `toWireUser` builds it — every key the client's `AuthUserModel` reads. */
const wireUser = {
  id: 42,
  first_name: 'سارة',
  last_name: 'الحلبي',
  full_name: 'سارة الحلبي',
  email: 'sara@qirtas.test',
  phone: '0933111222',
  image: null,
  address: null,
  is_admin: true,
  is_root_protected: false,
  mfa_enabled: false,
  email_verified: true,
  email_verified_at: '2026-08-01T09:00:00.000Z',
  status: 'active' as const,
  rejection_reason: null,
  requested_role_id: null,
  requested_branch_id: null,
  requested_ownership_percentage: null,
  submitted_at: '2026-07-20T09:00:00.000Z',
  decided_at: '2026-07-21T09:00:00.000Z',
  decided_by_user_id: 1,
  archived_at: null,
  created_at: '2026-07-20T09:00:00.000Z',
};

describe('POST /users/login → data', () => {
  const payload = {
    user: wireUser,
    token: 'opaque-session-token',
    session_id: 7,
    permission_keys: ['users.view', 'roles.view'],
    is_super_admin: false,
  };

  it('accepts the shape the client parses', () => {
    expect(loginResponseSchema.safeParse(payload).success).toBe(true);
  });

  it('names the account `user`, never `account`', () => {
    // The template this project came from uses `account`. Getting the two
    // confused is not hypothetical — it is the defect this suite exists for.
    const renamed = { ...payload, account: payload.user } as Record<string, unknown>;
    delete renamed.user;
    expect(loginResponseSchema.safeParse(renamed).success).toBe(false);
  });

  it('declares `is_super_admin` — the flag every admin control depends on', () => {
    // This assertion is the one that was missing. The service always returned
    // the field and `LoginModel` on the client always read it, but the schema
    // feeding `/openapi.json` did not declare it until 2026-08-17 — so the
    // published contract denied the existence of the flag that decides whether
    // admin controls render at all. A doc-only schema drifting is silent by
    // construction: nothing compares it to the service's return type.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { is_super_admin: _omitted, ...without } = payload;
    expect(loginResponseSchema.safeParse(without).success).toBe(false);
  });

  it('requires the token — a login response without one is not a login', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { token: _omitted, ...without } = payload;
    expect(loginResponseSchema.safeParse(without).success).toBe(false);
  });
});

describe('GET /users/me → data', () => {
  const payload = {
    user: wireUser,
    permission_keys: [] as string[],
    is_super_admin: false,
  };

  it('is the login envelope minus token and session_id', () => {
    expect(currentUserResponseSchema.safeParse(payload).success).toBe(true);
  });

  it('`declared_keys` is optional — present in debug, absent in release', () => {
    // It must be optional on **both** sides. A client that required it would
    // fail to parse every `/users/me` in production while passing every test
    // in debug; a server that always sent it would leak the enforced-permission
    // catalogue to every account.
    expect(currentUserResponseSchema.safeParse(payload).success).toBe(true);
    expect(
      currentUserResponseSchema.safeParse({ ...payload, declared_keys: ['users.view'] }).success,
    ).toBe(true);
  });

  it('an account with zero permissions is valid, not an error', () => {
    // `pending_verification` holds no assignment. This is the normal shape for
    // a real account, and the client distinguishes it from "not loaded yet".
    expect(payload.permission_keys).toEqual([]);
    expect(currentUserResponseSchema.safeParse(payload).success).toBe(true);
  });
});

describe('WireUser — the keys AuthUserModel reads', () => {
  it('parses every field the client maps, with nullables actually nullable', () => {
    expect(userResponseSchema.safeParse(wireUser).success).toBe(true);
  });

  it('`status` travels as the snake_case name the client switches on', () => {
    // `authUserStatusFromWire` ends in `_ => active`, so a renamed status does
    // not throw on the client — it silently lands an unverified account in the
    // main shell with zero permissions. The spelling is the whole contract.
    for (const status of [
      'pending_verification',
      'pending_approval',
      'active',
      'suspended',
      'rejected',
      'disabled',
    ]) {
      expect(userResponseSchema.safeParse({ ...wireUser, status }).success).toBe(true);
    }
  });

  it('rejects a status the client has no branch for', () => {
    expect(userResponseSchema.safeParse({ ...wireUser, status: 'archived' }).success).toBe(false);
  });

  it('`archived_at` is nullable, and null is a real answer', () => {
    // A fallback date on either side (`?? new Date(2000)`) passes a naive
    // round-trip and marks every live account retired since the year 2000.
    expect(userResponseSchema.safeParse({ ...wireUser, archived_at: null }).success).toBe(true);
    expect(
      userResponseSchema.safeParse({ ...wireUser, archived_at: '2026-08-10T09:00:00.000Z' })
        .success,
    ).toBe(true);
  });
});
