/**
 * Token rotation + session management, exercised the way the Flutter client
 * exercises them.
 *
 * ## ⚠️ Run each suite against a freshly started server
 *
 * The rate limiters are in-memory and deliberately tight — 5 sign-ins per
 * 15 minutes **per email and per IP**, 5 password-reset calls per hour per IP.
 * Running the three auth suites back to back exhausts both from one address, and
 * the later assertions then fail with 429. That is the limiter working, not a
 * regression. Restart the server between suites (it clears the counters) or
 * space the runs out.
 *
 * Rotation is deliberately tested by FORCING it: `SESSION_ROTATE_AFTER_HOURS`
 * defaults to 24, so a session created seconds ago is correctly returned
 * unchanged. Asserting only that would prove nothing about the branch that
 * matters — so this ages the session directly in the database and then asserts
 * both halves: the old token stops working, the new one works, and it is the
 * same session rather than a new one.
 */
import { Client } from 'pg';
import 'dotenv/config';

const B = 'http://localhost:3000/api/v1';
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

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const CREDS = { email: 'super_admin@admin.com', password: 'P@ssw0rd@123' };

// ── Two devices, each with its own label ─────────────────────────────────────
const a = await call('POST', '/users/login', { ...CREDS, device_info: 'Pixel 8 · android · v1.0.0' });
const b = await call('POST', '/users/login', { ...CREDS, device_info: 'iPhone 15 · ios · v1.0.0' });
chk('two sessions open', a.status === 200 && b.status === 200);
const TA = a.json?.data?.token;
const TB = b.json?.data?.token;

const list = await call('GET', '/auth/sessions', null, TA);
const rows = list.json?.data ?? [];
chk('both devices appear in the list', rows.length >= 2, `${rows.length} sessions`);
chk('the device label round-trips', rows.some((s) => s.device_info === 'Pixel 8 · android · v1.0.0'));
chk('exactly one row is is_current', rows.filter((s) => s.is_current).length === 1);
chk('no token ever appears in the payload', !JSON.stringify(rows).includes(TA) && !JSON.stringify(rows).includes(TB));

// ── A young session is NOT rotated ───────────────────────────────────────────
const young = await call('POST', '/auth/refresh', null, TA);
chk('a young token is returned unchanged', young.json?.data?.rotated === false && young.json?.data?.token === TA);

// ── Age it past the threshold, then rotate ──────────────────────────────────
const sessionId = rows.find((s) => s.is_current)?.id;
await db.query(
  `UPDATE sessions SET last_rotated_at = now() - interval '48 hours' WHERE id = $1`,
  [sessionId],
);

const rotated = await call('POST', '/auth/refresh', null, TA);
const TA2 = rotated.json?.data?.token;
chk('an aged token IS rotated', rotated.json?.data?.rotated === true, String(rotated.json?.data?.rotated));
chk('...and the new token differs', typeof TA2 === 'string' && TA2 !== TA);

const withNew = await call('GET', '/auth/sessions', null, TA2);
chk('the new token works', withNew.status === 200, `status ${withNew.status}`);

const withOld = await call('GET', '/auth/sessions', null, TA);
chk('the OLD token is dead', withOld.status === 401, `status ${withOld.status}`);

const stillSame = (withNew.json?.data ?? []).find((s) => s.is_current);
chk('rotation kept the same session, did not open a new one', stillSame?.id === sessionId, `${stillSame?.id} vs ${sessionId}`);

// ── Revoking someone else's session ─────────────────────────────────────────
const other = (withNew.json?.data ?? []).find((s) => !s.is_current);
const revoked = await call('DELETE', `/auth/sessions/${other.id}`, null, TA2);
chk('revoking another session succeeds', revoked.status === 200, `status ${revoked.status}`);

const bAfter = await call('GET', '/auth/sessions', null, TB);
chk('the revoked device is signed out', bAfter.status === 401, `status ${bAfter.status}`);

// ── Sign out others spares the caller ───────────────────────────────────────
const c = await call('POST', '/users/login', { ...CREDS, device_info: 'iPad · ios · v1.0.0' });
const TC = c.json?.data?.token;
const others = await call('POST', '/auth/sessions/revoke-others', null, TC);
chk('revoke-others succeeds', others.status === 200, `status ${others.status}`);
chk('...and reports how many ended', typeof others.json?.data?.sessions_revoked === 'number', JSON.stringify(others.json?.data));

const mine = await call('GET', '/auth/sessions', null, TC);
chk('the calling session SURVIVED revoke-others', mine.status === 200, `status ${mine.status}`);
chk('...and is the only one left', (mine.json?.data ?? []).length === 1, `${(mine.json?.data ?? []).length} left`);

const dead = await call('GET', '/auth/sessions', null, TA2);
chk('the other rotated session was ended by it', dead.status === 401, `status ${dead.status}`);

await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
