/**
 * End-to-end: the staff second factor (TOTP) — enrollment, the two-step sign-in,
 * recovery codes, lockout, forced enrollment, admin reset.
 *
 * Needs a server with enforcement ON (so "required" roles are actually forced):
 *
 *   MFA_ENFORCE=true MAIL_TRANSPORT=log PORT=3100 npm run dev > srv.log 2>&1
 *   E2E_BASE=http://localhost:3100/api/v1 E2E_ADMIN_PASSWORD=… node tests/mfa.e2e.mjs
 *
 * ⚠️ Leaves the seeded super admin ENROLLED (a required role cannot opt out
 * through the API). Clear it afterwards with:
 *   npx tsx tests/mfa-clear-admin.ts
 * or every later e2e run will be challenged for a code.
 *
 * The TOTP generator below is deliberately written again here instead of
 * imported from `src/`: a test that computes the expected code with the code
 * under test can only prove it agrees with itself. (`totp.test.ts` pins the
 * server's version to the RFC 6238 vectors.)
 */
import { createHmac } from 'node:crypto';

const B = process.env.E2E_BASE ?? 'http://localhost:3100/api/v1';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'super_admin@admin.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('Set E2E_ADMIN_PASSWORD (the seeded super admin password).');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const chk = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  [' + extra + ']' : ''}`);
};

async function call(method, path, body, token) {
  const r = await fetch(B + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept-language': 'en',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* non-JSON */
  }
  return { status: r.status, json };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of s.replace(/=+$/, '')) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totp(secretB32, stepOffset = 0) {
  const step = Math.floor(Date.now() / 30000) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1000000).padStart(6, '0');
}

async function login(email, password) {
  return call('POST', '/users/login', { email, password });
}

// ── admin (a required role) — signs in, is told to enroll, enrolls ───────────
let r = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
chk('required role, not enrolled: sign-in still succeeds (setup-only session)', r.status === 200 && r.json.data.token);
chk('…and says setup is required', r.json?.data?.mfa_setup_required === true);
const adminToken0 = r.json.data.token;

r = await call('GET', '/branches', null, adminToken0);
chk('setup-only session: ordinary endpoint refused 403 mfa_setup_required', r.status === 403 && r.json?.data?.message_key === 'mfa_setup_required', `${r.status}`);
r = await call('GET', '/users/me', null, adminToken0);
chk('…but /users/me still answers (client needs to see the flag)', r.status === 200 && r.json.data.mfa_setup_required === true);
r = await call('GET', '/auth/mfa', null, adminToken0);
chk('…and MFA status is reachable', r.status === 200 && r.json.data.required === true && r.json.data.enrolled === false);

r = await call('POST', '/auth/mfa/setup', null, adminToken0);
chk('setup returns a secret and an otpauth URI', r.status === 200 && r.json.data.secret && r.json.data.otpauth_uri.startsWith('otpauth://totp/'));
const adminSecret = r.json.data.secret;

r = await call('POST', '/auth/mfa/confirm', { code: '000000' }, adminToken0);
chk('confirm with a wrong code refused 401', r.status === 401 && r.json?.data?.message_key === 'mfa_code_invalid', `${r.status}`);
r = await call('POST', '/auth/mfa/confirm', { code: totp(adminSecret) }, adminToken0);
chk('confirm with the right code → 10 recovery codes', r.status === 200 && r.json.data.recovery_codes?.length === 10);
const initialCodes = r.json?.data?.recovery_codes ?? [];

r = await call('GET', '/branches', null, adminToken0);
chk('after enrolling the same session works everywhere', r.status === 200, `${r.status}`);

r = await call('POST', '/auth/mfa/setup', null, adminToken0);
chk('setup again once enrolled refused 409 (a stolen session cannot swap the factor)', r.status === 409 && r.json?.data?.message_key === 'mfa_already_enrolled');

// ── two-step sign-in ─────────────────────────────────────────────────────────
r = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
chk('enrolled: password alone gives NO session', r.status === 200 && r.json.data.mfa_required === true && !r.json.data.token);
const challenge = r.json.data.mfa_token;

r = await call('POST', '/users/login/mfa', { mfa_token: challenge, code: '000000' });
chk('wrong code refused 401', r.status === 401 && r.json?.data?.message_key === 'mfa_code_invalid', `${r.status}`);

r = await call('POST', '/users/login/mfa', { mfa_token: challenge, code: totp(adminSecret) });
chk('the code confirm just used is refused (same step replay)', r.status === 401, `${r.status}`);

r = await call('POST', '/users/login/mfa', { mfa_token: challenge, code: totp(adminSecret, 1) });
chk('the next step\'s code signs in with the full payload', r.status === 200 && r.json.data.token && r.json.data.permission_keys?.length > 0 && r.json.data.is_super_admin === true, `${r.status}`);
const adminToken = r.json?.data?.token;

r = await call('POST', '/users/login/mfa', { mfa_token: 'garbage.garbage', code: totp(adminSecret, 1) });
chk('forged challenge refused', r.status === 401 && r.json?.data?.message_key === 'mfa_challenge_invalid', `${r.status}`);

// A challenge from another account must not open this one.
r = await login(ADMIN_EMAIL, 'definitely-wrong-password');
chk('wrong password: no challenge issued (401, not a step-two prompt)', r.status === 401 && !r.json?.data?.mfa_token);

// ── recovery codes ───────────────────────────────────────────────────────────
// (A recovery code, not a TOTP: the sign-in above consumed the newest step the
// window allows, and a step can never be reused.)
r = await call('POST', '/auth/mfa/recovery-codes', { code: initialCodes[0] }, adminToken);
chk('regenerating codes needs a valid code', r.status === 200 && r.json.data.recovery_codes.length === 10, `${r.status}`);
const codes = r.json?.data?.recovery_codes ?? [];

r = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
let ch = r.json.data.mfa_token;
r = await call('POST', '/users/login/mfa', { mfa_token: ch, code: codes[0] });
chk('a recovery code signs in', r.status === 200 && r.json.data.token, `${r.status}`);
r = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
ch = r.json.data.mfa_token;
r = await call('POST', '/users/login/mfa', { mfa_token: ch, code: codes[0] });
chk('…exactly once', r.status === 401, `${r.status}`);
r = await call('POST', '/users/login/mfa', { mfa_token: ch, code: codes[1].toLowerCase().replace('-', '') });
chk('another code works, typed lower-case without the dash', r.status === 200, `${r.status}`);

// ── a required role cannot opt out; admin reset ──────────────────────────────
r = await call('POST', '/auth/mfa/disable', { password: ADMIN_PASSWORD, code: totp(adminSecret, 1) }, adminToken);
chk('a required role cannot disable its factor (409)', r.status === 409 && r.json?.data?.message_key === 'mfa_required_by_role', `${r.status}`);
r = await call('POST', '/auth/mfa/disable', { password: 'wrong-password-1', code: totp(adminSecret, 1) }, adminToken);
chk('disable with a wrong password refused 422 first', r.status === 422, `${r.status}`);

const me = (await call('GET', '/users/me', null, adminToken)).json?.data?.user;
r = await call('POST', `/users/${me.id}/mfa/reset`, null, adminToken);
chk('resetting your own factor refused 403', r.status === 403 && r.json?.data?.message_key === 'mfa_reset_self_forbidden', `${r.status}`);

const roles = (await call('GET', '/roles?limit=100', null, adminToken)).json?.data?.items ?? [];
const managerRole = roles.find((x) => x.name === 'مدير الفرع');
const stamp = Date.now();
const email = `mfa.e2e.${stamp}@example.com`;
r = await call('POST', '/users', { first_name: 'Test', last_name: 'Manager', email, phone: '0933' + String(stamp).slice(-6), password: 'Passw0rd!x', role_id: managerRole.id }, adminToken);
chk('created a branch manager for the reset test', r.status === 201, `${r.status}`);
const managerId = r.json?.data?.id;
r = await login(email, 'Passw0rd!x');
const mToken = r.json?.data?.token;
chk('manager is a required role → setup required', r.json?.data?.mfa_setup_required === true);
r = await call('POST', '/auth/mfa/setup', null, mToken);
const mSecret = r.json?.data?.secret;
await call('POST', '/auth/mfa/confirm', { code: totp(mSecret) }, mToken);
r = await call('POST', `/users/${managerId}/mfa/reset`, null, adminToken);
chk('admin resets the manager (200)', r.status === 200, `${r.status}`);
r = await call('GET', '/auth/mfa', null, mToken);
chk("…and the manager's old session is ended (401)", r.status === 401, `${r.status}`);
r = await login(email, 'Passw0rd!x');
chk('…they sign in with the password alone again, and must re-enroll', r.status === 200 && r.json.data.token && r.json.data.mfa_setup_required === true);

// ── lockout on the account ───────────────────────────────────────────────────
r = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
ch = r.json.data.mfa_token;
let last;
for (let i = 0; i < 5; i++) last = await call('POST', '/users/login/mfa', { mfa_token: ch, code: '111111' });
r = await call('POST', '/users/login/mfa', { mfa_token: ch, code: codes[2] });
chk('five wrong codes lock the account: even a valid recovery code is refused 429', r.status === 429 && r.json?.data?.message_key === 'mfa_locked', `${r.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
console.log('Now run: npx tsx tests/mfa-clear-admin.ts   (the admin is locked and enrolled)');
process.exit(fail ? 1 : 0);
