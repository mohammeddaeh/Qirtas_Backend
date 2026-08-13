/**
 * PHASE 8 — adversarial checks.
 *
 * These do not test that the happy path works (the other three suites do that).
 * They try to **break** the auth surface: take over another account, read
 * another account's sessions, escalate privileges through registration, revive
 * a dead session, or spend somebody else's verification code.
 *
 * ⚠️ Run against a freshly started server — the rate limiters are in-memory and
 * tight; see `auth-rotation.e2e.mjs`.
 */
import { readFileSync } from 'node:fs';

const B = 'http://localhost:3000/api/v1';
const LOG = 'C:/Users/PC-056/AppData/Local/Temp/srv.log';
let pass = 0, fail = 0;
const chk = (n, ok, x = '') => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${n}${x ? '  [' + x + ']' : ''}`); };

async function call(m, p, body, token) {
  const r = await fetch(B + p, {
    method: m,
    headers: {
      'Content-Type': 'application/json',
      'Accept-language': 'en',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json: j };
}

function readCode(email) {
  const log = readFileSync(LOG, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const blocks = [...log.matchAll(/to: "([^"]+)"[\s\S]{0,400}?body: "([\s\S]*?)"\n/g)].filter((m) => m[1] === email);
  if (!blocks.length) return null;
  // Alphabet-agnostic — see the same note in auth-verification.e2e.mjs.
  const m = blocks[blocks.length - 1][2].match(/ {4}([A-Z0-9]{4,12})\\n/);
  return m ? m[1] : null;
}

/** Polls instead of reading once — see the same note in auth-verification.e2e.mjs. */
async function latestCode(email, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = readCode(email);
    if (code !== null) return code;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const admin = await call('POST', '/users/login', { email: 'super_admin@admin.com', password: 'P@ssw0rd@123' });
const AT = admin.json?.data?.token;
const roleId = admin.status === 200
  ? (await call('GET', '/roles?page=1&limit=1', null, AT)).json?.data?.items?.[0]?.id
  : null;
chk('setup: admin session + a role', !!AT && !!roleId);

// ── Two independent victim/attacker accounts ────────────────────────────────
const mk = async (tag) => {
  const email = `sec_${tag}_${Date.now()}@qirtas.test`;
  await call('POST', '/users/register', {
    first_name: 'Sec', last_name: tag, email, phone: '0900000003',
    password: 'Testpass123', requested_role_id: roleId,
  });
  const li = await call('POST', '/users/login', { email, password: 'Testpass123' });
  return { email, token: li.json?.data?.token };
};
const victim = await mk('victim');
const attacker = await mk('attacker');
chk('setup: two accounts with sessions', !!victim.token && !!attacker.token);

// ── 1. IDOR: can the attacker see the victim's sessions? ────────────────────
const mine = await call('GET', '/auth/sessions', null, attacker.token);
const ids = (mine.json?.data ?? []).map((s) => s.id);
const victimSessions = await call('GET', '/auth/sessions', null, victim.token);
const victimIds = (victimSessions.json?.data ?? []).map((s) => s.id);
chk('sessions list is scoped to the caller', !ids.some((id) => victimIds.includes(id)),
  `attacker ${JSON.stringify(ids)} vs victim ${JSON.stringify(victimIds)}`);

// ── 2. IDOR: can the attacker REVOKE the victim's session? ──────────────────
const steal = await call('DELETE', `/auth/sessions/${victimIds[0]}`, null, attacker.token);
chk('revoking another account\'s session is refused', steal.status === 404, `status ${steal.status}`);
const victimStillIn = await call('GET', '/auth/sessions', null, victim.token);
chk('...and the victim is still signed in', victimStillIn.status === 200, `status ${victimStillIn.status}`);

// ── 3. Can the attacker spend the victim's verification code? ───────────────
await new Promise((r) => setTimeout(r, 300));
const victimCode = await latestCode(victim.email);
chk('captured the victim\'s code', !!victimCode, String(victimCode));
const cross = await call('POST', '/auth/verify-email', { code: victimCode }, attacker.token);
chk('a code cannot be spent by another account', cross.status === 422, `status ${cross.status}`);
const victimMe = await call('GET', '/users/me', null, victim.token);
chk('...and the victim stays unverified', victimMe.json?.data?.user?.email_verified === false);
// ...but the rightful owner can still use it — proving the refusal was about
// ownership, not about the code having been burned.
const rightful = await call('POST', '/auth/verify-email', { code: victimCode }, victim.token);
chk('the rightful owner CAN still spend it', rightful.status === 200, `status ${rightful.status}`);

// ── 4. Privilege escalation through registration ────────────────────────────
const esc = `sec_esc_${Date.now()}@qirtas.test`;
const escalate = await call('POST', '/users/register', {
  first_name: 'Esc', last_name: 'Alate', email: esc, phone: '0900000004',
  password: 'Testpass123', requested_role_id: roleId,
  // The payload an attacker would try. `.strict()` is not set on this schema,
  // so zod strips them silently — and the store no longer reads them either.
  is_admin: true, status: 'active', email_verified: true, id: 1,
});
// The response carries a sign-in result now ({user, token, permission_keys}),
// so every claim below reads through `.user` — and the session it hands out is
// checked here too: a registration that could inject privilege AND arrive
// holding a token is the escalation this section exists to rule out.
const escUser = escalate.json?.data?.user;
chk('registration with injected privileged fields still succeeds', escalate.status === 201, `status ${escalate.status}`);
chk('...but is_admin was NOT granted', escUser?.is_admin === false, String(escUser?.is_admin));
chk('...and status was NOT forced to active', escUser?.status === 'pending_verification', escUser?.status);
chk('...and email_verified was NOT forced', escUser?.email_verified === false, String(escUser?.email_verified));
chk('...and the id was NOT overridden', escUser?.id !== 1, String(escUser?.id));
chk('...and the session it hands back opens nothing', escalate.json?.data?.permission_keys?.length === 0, JSON.stringify(escalate.json?.data?.permission_keys));

// ── 5. Can a revoked session be revived by refresh? ─────────────────────────
const doomed = await call('POST', '/users/login', { email: victim.email, password: 'Testpass123' });
const DT = doomed.json?.data?.token;
await call('POST', '/users/logout', null, DT);
const revive = await call('POST', '/auth/refresh', null, DT);
chk('refresh cannot revive a signed-out session', revive.status === 401, `status ${revive.status}`);

// ── 6. Does a password reset really kill existing sessions? ─────────────────
const living = await call('POST', '/users/login', { email: victim.email, password: 'Testpass123' });
const LT = living.json?.data?.token;
await call('POST', '/auth/forgot-password', { email: victim.email });
await new Promise((r) => setTimeout(r, 300));
const resetCode = await latestCode(victim.email);
const reset = await call('POST', '/auth/reset-password', {
  email: victim.email, code: resetCode, new_password: 'Newpass456',
});
chk('password reset succeeds', reset.status === 200, `status ${reset.status}`);
const afterReset = await call('GET', '/auth/sessions', null, LT);
chk('every pre-reset session is dead', afterReset.status === 401, `status ${afterReset.status}`);
const oldPw = await call('POST', '/users/login', { email: victim.email, password: 'Testpass123' });
chk('the old password no longer works', oldPw.status === 401, `status ${oldPw.status}`);

// ── 7. Unauthenticated access to session endpoints ─────────────────────────
for (const [m, p] of [['GET', '/auth/sessions'], ['DELETE', '/auth/sessions/1'], ['POST', '/auth/sessions/revoke-others']]) {
  const r = await call(m, p, null, null);
  chk(`${m} ${p} refuses an anonymous caller`, r.status === 401, `status ${r.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
