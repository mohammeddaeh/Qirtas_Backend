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

/** Pulls the newest code the LogEmailSender wrote for [email]. pino-pretty colours its keys, so ANSI is stripped first. */
function readCode(email) {
  const log = readFileSync(LOG, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const blocks = [...log.matchAll(/to: "([^"]+)"[\s\S]{0,400}?body: "([\s\S]*?)"\n/g)].filter((m) => m[1] === email);
  if (!blocks.length) return null;
  // The template indents the code by four spaces on its own line; that is the
  // only such run in the body, so it is anchor enough.
  // Alphabet-agnostic on purpose. This was `[A-Z2-9]{8}` and stopped matching
  // the day the code became six digits — every assertion downstream then failed
  // with "null", which reads as a broken verification flow rather than a broken
  // parser. The length range covers both formats and the next one.
  const m = blocks[blocks.length - 1][2].match(/ {4}([A-Z0-9]{4,12})\\n/);
  return m ? m[1] : null;
}

/**
 * Waits for the code to appear, rather than assuming it already has.
 *
 * The HTTP response returning does not mean the log line has been written:
 * pino-pretty runs as a transport in a worker thread, so the line lands a beat
 * after the request completes. Reading once, immediately, lost that race often
 * enough to look like a broken verification flow — the same `null` a genuinely
 * missing code produces, and eight cascading failures below it.
 */
async function latestCode(email, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = readCode(email);
    if (code !== null) return code;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Reads a paginated list, refusing to treat a failed request as an empty one.
 *
 * The first version returned `[]` on any unexpected shape, and the queue query
 * used `limit=200` — over the schema's cap of 100, so it 422'd and every
 * "is X in the queue?" assertion silently evaluated against nothing. The
 * ABSENT check passed for the wrong reason and the PRESENT check failed for the
 * right one, which is the only reason it was noticed at all.
 */
const items = (res) => {
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);
  const list = res.json?.data?.items;
  if (!Array.isArray(list)) throw new Error(`no items[] in ${JSON.stringify(res.json).slice(0, 200)}`);
  return list;
};

/** Walks every page — the queue is longer than one page and the cap is 100. */
async function allPendingApproval(token) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const res = await call('GET', `/users?page=${page}&limit=100&status=pending_approval`, null, token);
    const list = items(res);
    out.push(...list);
    if (page >= (res.json?.data?.total_pages ?? 1)) return out;
  }
}

const admin = await call('POST', '/users/login', { email: 'super_admin@admin.com', password: 'P@ssw0rd@123' });
const AT = admin.json?.data?.token;
const roles = await call('GET', '/roles?page=1&limit=1', null, AT);
const roleId = roles.json?.data?.items?.[0]?.id;
chk('picked a role to request', !!roleId, String(roleId));

const email = `e2e_verify_${Date.now()}@qirtas.test`;
const reg = await call('POST', '/users/register', {
  first_name: 'E2E', last_name: 'Verify', email, phone: '0900000001',
  password: 'Testpass123', requested_role_id: roleId,
});
chk('registration accepted', reg.status === 201, `status ${reg.status}`);
chk('lands at pending_verification, NOT pending_approval', reg.json?.data?.user?.status === 'pending_verification', reg.json?.data?.user?.status);
chk('email_verified is false', reg.json?.data?.user?.email_verified === false);
chk('message names the verification step', /confirm your email/i.test(reg.json?.message || ''), reg.json?.message);

// The session ships with the registration, because the step the message names
// (POST /auth/verify-email) is requireAuth. Without this the client has to send
// the user to the sign-in screen to retype credentials it was just handed.
const RT = reg.json?.data?.token;
chk('registration hands back a session', !!RT, String(RT));
chk('...that holds zero permissions', reg.json?.data?.permission_keys?.length === 0, JSON.stringify(reg.json?.data?.permission_keys));
const regMe = await call('GET', '/users/me', null, RT);
chk('...and the token actually works', regMe.status === 200 && regMe.json?.data?.user?.email === email, `status ${regMe.status}`);

// The anti-flood guarantee: an unproven address never reaches the admin's queue.
const q1 = await allPendingApproval(AT);
chk('unverified registration is ABSENT from the admin queue', !q1.some((u) => u.email === email), `queue size ${q1.length}`);

const li = await call('POST', '/users/login', { email, password: 'Testpass123' });
chk('unverified account can still sign in', li.status === 200, `status ${li.status}`);
const UT = li.json?.data?.token;
chk('but holds zero permissions', li.json?.data?.permission_keys?.length === 0, JSON.stringify(li.json?.data?.permission_keys));

await new Promise((r) => setTimeout(r, 400));
const code = await latestCode(email);
chk('a verification code was issued', !!code, String(code));

const wrong = await call('POST', '/auth/verify-email', { code: 'AAAAAAAA' }, UT);
chk('a wrong code is 422', wrong.status === 422, `status ${wrong.status}`);
chk('...with the generic message_key', wrong.json?.data?.message_key === 'verification_code_invalid', wrong.json?.data?.message_key);

const v = await call('POST', '/auth/verify-email', { code }, UT);
chk('the correct code verifies', v.status === 200, `status ${v.status} ${JSON.stringify(v.json?.message)}`);

const me = await call('GET', '/users/me', null, UT);
chk('account advanced to pending_approval', me.json?.data?.user?.status === 'pending_approval', me.json?.data?.user?.status);
chk('email_verified is now true', me.json?.data?.user?.email_verified === true);
chk('email_verified_at is stamped', !!me.json?.data?.user?.email_verified_at, me.json?.data?.user?.email_verified_at);

const q2 = await allPendingApproval(AT);
chk('verified registration IS now in the admin queue', q2.some((u) => u.email === email), `queue size ${q2.length}`);

const rs = await call('POST', '/auth/resend-verification', null, UT);
chk('resend on a verified account is 409', rs.status === 409, `status ${rs.status}`);
chk('...naming the reason', rs.json?.data?.message_key === 'verification_already_verified', rs.json?.data?.message_key);

// ── Attempt ceiling: the bound that survives IP rotation ─────────────────────
const email2 = `e2e_burn_${Date.now()}@qirtas.test`;
await call('POST', '/users/register', {
  first_name: 'E2E', last_name: 'Burn', email: email2, phone: '0900000002',
  password: 'Testpass123', requested_role_id: roleId,
});
const li2 = await call('POST', '/users/login', { email: email2, password: 'Testpass123' });
const UT2 = li2.json?.data?.token;
await new Promise((r) => setTimeout(r, 400));
const realCode = await latestCode(email2);
chk('second account got its own code', !!realCode && realCode !== code, String(realCode));

for (let i = 0; i < 5; i += 1) await call('POST', '/auth/verify-email', { code: 'BBBBBBBB' }, UT2);
const burned = await call('POST', '/auth/verify-email', { code: realCode }, UT2);
chk('the REAL code is refused after the attempt ceiling is hit', burned.status === 422, `status ${burned.status}`);

const meBurn = await call('GET', '/users/me', null, UT2);
chk('...and the account stayed unverified', meBurn.json?.data?.user?.email_verified === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
