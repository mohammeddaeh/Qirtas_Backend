/**
 * End-to-end: the customer realm — sign-up, unified sign-in, realm isolation,
 * verification, reset, admin suspension, branch preference.
 *
 * Needs a server started with the log mail transport writing to a file, so the
 * codes can be read back:
 *
 *   MAIL_TRANSPORT=log PORT=3100 npm run dev > srv.log 2>&1
 *   E2E_BASE=http://localhost:3100/api/v1 E2E_LOG=srv.log E2E_ADMIN_PASSWORD=… \
 *     node tests/customer-accounts.e2e.mjs
 *
 * ⚠️ Registration is rate-limited (5/hour/IP, in memory) and this file spends
 * five of them — restart the server between runs or the second run fails with 429.
 *
 * Every case that matters is paired with its opposite. A realm-isolation check
 * that only proves "customer token is refused on staff routes" passes for a
 * server refusing EVERYTHING; so the same file proves the staff token still
 * works there, and the customer token still works on its own routes.
 */
import { readFileSync } from 'node:fs';

const B = process.env.E2E_BASE ?? 'http://localhost:3100/api/v1';
const LOG = process.env.E2E_LOG ?? 'srv.log';
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

/** Newest code the log mail transport wrote for [email]. ANSI is stripped: pino-pretty colours its keys. */
function readCode(email) {
  const log = readFileSync(LOG, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const blocks = [...log.matchAll(/to: "([^"]+)"[\s\S]{0,400}?body: "([\s\S]*?)"\n/g)].filter(
    (m) => m[1] === email,
  );
  if (!blocks.length) return null;
  const m = blocks[blocks.length - 1][2].match(/ {4}([A-Z0-9]{4,12})\\n/);
  return m ? m[1] : null;
}

/** The log line lands a beat after the response (pino-pretty is a worker-thread transport). */
async function latestCode(email, previous = null, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = readCode(email);
    if (code !== null && code !== previous) return code;
    if (Date.now() >= deadline) return code;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const PW = 'Str0ng!Passw0rd#1';
const email = `e2e_customer_${Date.now()}@qirtas.test`;
const other = `e2e_customer_b_${Date.now()}@qirtas.test`;

// ── Sign-up ──────────────────────────────────────────────────────────────────
const reg = await call('POST', '/customers/register', {
  first_name: 'Test',
  last_name: 'Customer',
  email,
  password: PW,
});
chk('register → 201', reg.status === 201, String(reg.status));
const CT = reg.json?.data?.token;
chk('token carries the customer prefix', typeof CT === 'string' && CT.startsWith('c_'));
chk('account_type is customer', reg.json?.data?.account_type === 'customer');
chk('starts active', reg.json?.data?.customer?.status === 'active');
chk('starts UNverified', reg.json?.data?.customer?.email_verified === false);
chk('always retail on self-registration', reg.json?.data?.customer?.customer_type === 'retail');

const smuggled = await call('POST', '/customers/register', {
  first_name: 'S',
  last_name: 'M',
  email: other,
  password: PW,
  customer_type: 'wholesale',
  status: 'active',
});
chk(
  'body cannot promote itself to wholesale',
  smuggled.status === 201 && smuggled.json?.data?.customer?.customer_type === 'retail',
  String(smuggled.json?.data?.customer?.customer_type),
);

// ── Duplicates across BOTH realms ────────────────────────────────────────────
const dupSame = await call('POST', '/customers/register', {
  first_name: 'A', last_name: 'B', email, password: PW,
});
chk('same email again → 409', dupSame.status === 409, String(dupSame.status));
const dupCase = await call('POST', '/customers/register', {
  first_name: 'A', last_name: 'B', email: email.toUpperCase(), password: PW,
});
chk('same email, other case → 409', dupCase.status === 409, String(dupCase.status));
const dupStaff = await call('POST', '/customers/register', {
  first_name: 'A', last_name: 'B', email: ADMIN_EMAIL, password: PW,
});
chk('a STAFF address cannot become a customer → 409', dupStaff.status === 409, String(dupStaff.status));

// ── Unified sign-in ──────────────────────────────────────────────────────────
const cLogin = await call('POST', '/users/login', { email, password: PW });
chk('customer signs in through /users/login', cLogin.status === 200 && cLogin.json?.data?.account_type === 'customer');
const CT2 = cLogin.json?.data?.token;

const sLogin = await call('POST', '/users/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
chk('staff still signs in through the same endpoint', sLogin.status === 200);
chk('staff payload keeps its shape + account_type', sLogin.json?.data?.account_type === 'staff' && Array.isArray(sLogin.json?.data?.permission_keys));
const AT = sLogin.json?.data?.token;

const bad = await call('POST', '/users/login', { email, password: 'wrong' });
const ghost = await call('POST', '/users/login', { email: 'nobody@qirtas.test', password: 'wrong' });
chk('wrong password → 401', bad.status === 401);
chk('unknown address → the SAME 401 and message (no membership oracle)', ghost.status === 401 && ghost.json?.message === bad.json?.message);

// ── Realm isolation, both directions ─────────────────────────────────────────
chk('customer token works on customer routes', (await call('GET', '/customers/me', null, CT)).status === 200);
chk('customer token REFUSED on a staff route (/users/me)', (await call('GET', '/users/me', null, CT)).status === 401);
chk('customer token REFUSED on the admin list', (await call('GET', '/customers', null, CT)).status === 401);
chk('staff token works on the admin list', (await call('GET', '/customers?limit=5', null, AT)).status === 200);
chk('staff token REFUSED on customer routes (/customers/me)', (await call('GET', '/customers/me', null, AT)).status === 401);
chk('a forged prefix on a staff token finds nothing', (await call('GET', '/customers/me', null, 'c_' + AT)).status === 401);

// ── Profile ──────────────────────────────────────────────────────────────────
const patch = await call('PATCH', '/customers/me', { phone: '0933111222' }, CT);
chk('PATCH /customers/me updates the phone', patch.status === 200 && patch.json?.data?.phone === '0933111222');
chk('PATCH with nothing → 422', (await call('PATCH', '/customers/me', {}, CT)).status === 422);
const noStatus = await call('PATCH', '/customers/me', { status: 'disabled' }, CT);
chk('PATCH cannot touch status (unknown key is dropped → nothing left → 422)', noStatus.status === 422, String(noStatus.status));
chk('…and the account is still active', (await call('GET', '/customers/me', null, CT)).json?.data?.status === 'active');

// ── Email verification ───────────────────────────────────────────────────────
const sent = await latestCode(email);
chk('a verification code was mailed on sign-up', !!sent, String(sent));
chk('wrong code → 422', (await call('POST', '/auth/verify-email', { code: '000000' }, CT)).status === 422);
const ok = await call('POST', '/auth/verify-email', { code: sent }, CT);
chk('right code → verified', ok.status === 200 && ok.json?.data?.email_verified === true, String(ok.status));
chk('/customers/me now reports verified', (await call('GET', '/customers/me', null, CT)).json?.data?.email_verified === true);
chk('verifying again is idempotent, not an error', (await call('POST', '/auth/verify-email', { code: sent }, CT)).status === 200);
chk('a spent code cannot verify ANOTHER customer', (await call('POST', '/auth/verify-email', { code: sent }, smuggled.json?.data?.token)).status === 422);

// ── Sessions belong to their realm ───────────────────────────────────────────
const sessions = await call('GET', '/auth/sessions', null, CT);
chk('customer lists their own sessions', sessions.status === 200 && Array.isArray(sessions.json?.data) && sessions.json.data.length >= 2);

// ── Password reset (customer realm, resolved from the address) ───────────────
const before = await latestCode(email);
chk('forgot-password answers 204/200 for a real customer', [200, 204].includes((await call('POST', '/auth/forgot-password', { email })).status));
chk('…and identically for an unknown address',
  [200, 204].includes((await call('POST', '/auth/forgot-password', { email: 'nobody@qirtas.test' })).status));
const resetCode = await latestCode(email, before);
chk('a reset code was mailed', !!resetCode && resetCode !== before, String(resetCode));
const NEWPW = 'An0ther!Passw0rd#2';
chk('reset with the code → ok', [200, 204].includes((await call('POST', '/auth/reset-password', { email, code: resetCode, new_password: NEWPW })).status));
chk('the OLD password no longer works', (await call('POST', '/users/login', { email, password: PW })).status === 401);
chk('the new password works', (await call('POST', '/users/login', { email, password: NEWPW })).status === 200);
chk('a CUSTOMER reset does not touch STAFF sessions', (await call('GET', '/customers?limit=1', null, AT)).status === 200);
chk('every earlier session was revoked by the reset', (await call('GET', '/customers/me', null, CT)).status === 401);

// ── Admin management ─────────────────────────────────────────────────────────
const fresh = await call('POST', '/users/login', { email, password: NEWPW });
const CT3 = fresh.json?.data?.token;
const found = await call('GET', `/customers?search=${encodeURIComponent(email)}`, null, AT);
const id = found.json?.data?.items?.[0]?.id;
chk('admin finds the customer by email', !!id, String(id));
chk('unverified filter excludes a verified customer',
  !(await call('GET', `/customers?email_verified=false&search=${encodeURIComponent(email)}`, null, AT)).json?.data?.items?.some((c) => c.id === id));

const susp = await call('POST', `/customers/${id}/suspend`, null, AT);
chk('suspend → suspended', susp.status === 200 && susp.json?.data?.status === 'suspended', String(susp.status));
chk('suspension takes effect on the VERY NEXT request', (await call('GET', '/customers/me', null, CT3)).status === 401);
const blocked = await call('POST', '/users/login', { email, password: NEWPW });
chk('a suspended customer cannot sign in → 403 account_suspended', blocked.status === 403 && blocked.json?.data?.account_status === 'suspended');
const again = await call('POST', `/customers/${id}/suspend`, null, AT);
chk('suspending twice is harmless', again.status === 200 && again.json?.data?.status === 'suspended');
const back = await call('POST', `/customers/${id}/reactivate`, null, AT);
chk('reactivate → active', back.status === 200 && back.json?.data?.status === 'active');
const CT4 = (await call('POST', '/users/login', { email, password: NEWPW })).json?.data?.token;
chk('…and they can sign in again', !!CT4);
chk('a customer cannot suspend anyone', (await call('POST', `/customers/${id}/suspend`, null, CT4)).status === 401);

// ── Branch preference ────────────────────────────────────────────────────────
const branches = await call('GET', '/branches/self-registerable');
const branchId = branches.json?.data?.[0]?.id;
chk('the branch catalog is public', branches.status === 200 && !!branchId);
const pref = await call('PATCH', '/customers/me', { preferred_branch_id: branchId }, CT4);
chk('a customer can prefer a real branch', pref.status === 200 && pref.json?.data?.preferred_branch_id === branchId);
chk('…but not one that does not exist', [404, 422].includes((await call('PATCH', '/customers/me', { preferred_branch_id: 999999 }, CT4)).status));
chk('nearest with no coordinates answers with the default',
  (await call('POST', '/branches/nearest', {})).json?.data?.resolved_by !== undefined);
chk('half a coordinate → 422', (await call('POST', '/branches/nearest', { latitude: 33.5 })).status === 422);

// ── Wholesale: request → queue → decision ────────────────────────────────────
const UNVERIFIED = smuggled.json?.data?.token;
const gate = await call('POST', '/customers/me/wholesale-request', null, UNVERIFIED);
chk('an UNverified customer cannot request wholesale → 403 email_verification_required',
  gate.status === 403 && gate.json?.data?.message_key === 'email_verification_required', String(gate.status));
chk('a guest cannot request it at all → 401', (await call('POST', '/customers/me/wholesale-request')).status === 401);
chk('a staff token cannot request it → 401', (await call('POST', '/customers/me/wholesale-request', null, AT)).status === 401);

const ask = await call('POST', '/customers/me/wholesale-request', null, CT4);
chk('a VERIFIED customer can request → pending', ask.status === 200 && ask.json?.data?.wholesale_status === 'pending', String(ask.status));
chk('…and stays RETAIL until an admin decides', ask.json?.data?.customer_type === 'retail');
chk('asking twice → 409', (await call('POST', '/customers/me/wholesale-request', null, CT4)).status === 409);
const queue = await call('GET', '/customers?wholesale_status=pending&limit=100', null, AT);
chk('the request is in the pending queue', queue.json?.data?.items?.some((c) => c.id === id));
chk('a customer cannot decide their own request', (await call('POST', `/customers/${id}/wholesale/decide`, { decision: 'approve' }, CT4)).status === 401);
chk('rejecting without a reason → 422', (await call('POST', `/customers/${id}/wholesale/decide`, { decision: 'reject' }, AT)).status === 422);
const rej = await call('POST', `/customers/${id}/wholesale/decide`, { decision: 'reject', reason: 'Missing documents' }, AT);
chk('reject records the reason and keeps retail', rej.status === 200 && rej.json?.data?.wholesale_status === 'rejected' && rej.json?.data?.customer_type === 'retail' && rej.json?.data?.wholesale_rejection_reason === 'Missing documents');
chk('deciding an already-decided request → 409', (await call('POST', `/customers/${id}/wholesale/decide`, { decision: 'approve' }, AT)).status === 409);
const again2 = await call('POST', '/customers/me/wholesale-request', null, CT4);
chk('a rejected customer may ask again (reason cleared)', again2.status === 200 && again2.json?.data?.wholesale_status === 'pending' && again2.json?.data?.wholesale_rejection_reason === null);
const app = await call('POST', `/customers/${id}/wholesale/decide`, { decision: 'approve' }, AT);
chk('approve → wholesale + approved', app.status === 200 && app.json?.data?.customer_type === 'wholesale' && app.json?.data?.wholesale_status === 'approved');
chk('an approved customer cannot ask again → 409', (await call('POST', '/customers/me/wholesale-request', null, CT4)).status === 409);

// ── Activity + support actions ───────────────────────────────────────────────
const act = await call('GET', `/customers/${id}/activity?limit=50`, null, AT);
chk('activity lists what the customer did', act.status === 200 && act.json?.data?.items?.some((e) => e.action === 'customer.wholesale_requested'));
chk('activity includes sign-ins', act.json?.data?.items?.some((e) => e.action.startsWith('auth.login')));
chk('a customer cannot read the activity log', (await call('GET', `/customers/${id}/activity`, null, CT4)).status === 401);
const uid = smuggled.json?.data?.customer?.id;
chk('resend verification for a VERIFIED customer → 409', (await call('POST', `/customers/${id}/resend-verification`, null, AT)).status === 409);
// The sign-up code went out seconds ago, so the honest answer is the cooldown
// (429) — reaching it proves the request got past the guards to the mailer.
const resend = await call('POST', `/customers/${uid}/resend-verification`, null, AT);
chk('resend verification for an unverified customer reaches the mailer (200, or 429 cooldown)',
  resend.status === 200 || (resend.status === 429 && resend.json?.data?.message_key === 'verification_resend_cooldown'), String(resend.status));
chk('an admin can trigger a password reset (mailed to the customer)', (await call('POST', `/customers/${id}/password-reset`, null, AT)).status === 200);

// ── Sign-out ─────────────────────────────────────────────────────────────────
chk('logout with a customer token → ok', (await call('POST', '/users/logout', null, CT4)).status === 200);
chk('the logged-out token is dead', (await call('GET', '/customers/me', null, CT4)).status === 401);

// ── Contact policy + self-service erase ──────────────────────────────────────
const seen = await call('GET', `/customers?search=${encodeURIComponent(other)}`, null, AT);
chk('a holder of customers.contact sees the real address', seen.json?.data?.items?.[0]?.email === other, String(seen.json?.data?.items?.[0]?.email));

chk('erasing needs the password: none → 422', (await call('DELETE', '/customers/me', {}, UNVERIFIED)).status === 422);
const wrongPw = await call('DELETE', '/customers/me', { password: 'wrong-password' }, UNVERIFIED);
chk('a wrong password → 422, NOT 401 (the client would sign the user out)', wrongPw.status === 422 && wrongPw.json?.data?.message_key === 'current_password_wrong', String(wrongPw.status));
chk('…and the account is still there', (await call('GET', '/customers/me', null, UNVERIFIED)).status === 200);
chk('a staff token cannot erase a customer account → 401', (await call('DELETE', '/customers/me', { password: PW }, AT)).status === 401);
chk('the right password erases the account', (await call('DELETE', '/customers/me', { password: PW }, UNVERIFIED)).status === 200);
chk('…its token is dead', (await call('GET', '/customers/me', null, UNVERIFIED)).status === 401);
chk('…it cannot sign in', (await call('POST', '/users/login', { email: other, password: PW })).status === 401);
chk('…and the admin no longer lists it', !(await call('GET', `/customers?search=${encodeURIComponent(other)}`, null, AT)).json?.data?.items?.length);

// ── Retiring an account ──────────────────────────────────────────────────────
const arch = await call('POST', `/customers/${id}/archive`, null, AT);
chk('archiving forces disabled', arch.status === 200 && arch.json?.data?.status === 'disabled' && arch.json?.data?.archived_at !== null, String(arch.status));
chk('an archived customer is hidden from the default list',
  !(await call('GET', `/customers?search=${encodeURIComponent(email)}`, null, AT)).json?.data?.items?.some((c) => c.id === id));
chk('…and shown by ?archived=true',
  (await call('GET', `/customers?archived=true&search=${encodeURIComponent(email)}`, null, AT)).json?.data?.items?.some((c) => c.id === id));
chk('reactivating an ARCHIVED customer is refused → 409', (await call('POST', `/customers/${id}/reactivate`, null, AT)).status === 409);
const un = await call('POST', `/customers/${id}/unarchive`, null, AT);
chk('unarchive brings it back but still DISABLED', un.status === 200 && un.json?.data?.archived_at === null && un.json?.data?.status === 'disabled');
chk('unarchiving one that is not archived → 409', (await call('POST', `/customers/${id}/unarchive`, null, AT)).status === 409);
const live = await call('POST', '/customers/register', { first_name: 'L', last_name: 'V', email: `e2e_customer_live_${Date.now()}@qirtas.test`, password: PW });
chk('deleting an ACTIVE customer is refused → 409', (await call('DELETE', `/customers/${live.json?.data?.customer?.id}`, null, AT)).status === 409);
chk('deleting a disabled customer → 200', (await call('DELETE', `/customers/${id}`, null, AT)).status === 200);
chk('…and it is gone', (await call('GET', `/customers/${id}`, null, AT)).status === 404);
chk('…and cannot sign in', (await call('POST', '/users/login', { email, password: NEWPW })).status === 401);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
