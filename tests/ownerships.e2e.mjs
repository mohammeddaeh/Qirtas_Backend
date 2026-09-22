/**
 * End-to-end: ownership shares — list with names, the 100% cap, revise (history
 * kept), end, and who may see any of it.
 *
 *   MAIL_TRANSPORT=log PORT=3100 npm run dev > srv.log 2>&1
 *   E2E_BASE=http://localhost:3100/api/v1 E2E_ADMIN_PASSWORD=… node tests/ownerships.e2e.mjs
 *
 * Runs on a **fresh branch** created for the run, so the 100% pool it fills is
 * its own and never collides with real shares in the dev database. Every case
 * that proves a refusal is paired with the acceptance next to it — a cap check
 * that only shows "121% is refused" passes for a server refusing everything.
 */
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

let r = await call('POST', '/users/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
const admin = r.json?.data?.token;
chk('admin signs in', !!admin);

const stamp = Date.now();
r = await call('POST', '/branches', { name: `Ownership e2e ${stamp}` }, admin);
const branchId = r.json?.data?.id;
chk('fresh branch created', r.status === 201 && branchId, `${r.status}`);

const roles = (await call('GET', '/roles?limit=100', null, admin)).json?.data?.items ?? [];
const partnerRole = roles.find((x) => x.name === 'شريك مالي');
const makeUser = async (label) => {
  const res = await call(
    'POST',
    '/users',
    {
      first_name: label,
      last_name: 'Partner',
      email: `own.${label.toLowerCase()}.${stamp}@example.com`,
      phone: '0933' + String(stamp + label.length).slice(-6),
      password: 'Passw0rd!x',
      role_id: partnerRole.id,
    },
    admin,
  );
  return res.json?.data?.id;
};
const u1 = await makeUser('Aya');
const u2 = await makeUser('Bassel');
const u3 = await makeUser('Dana');
chk('three partner accounts created', !!u1 && !!u2 && !!u3);

// ── create + list with names ─────────────────────────────────────────────────
r = await call('POST', '/ownerships', { user_id: u1, percentage: 60, branch_scope: branchId }, admin);
chk('60% created, response carries the names', r.status === 201 && r.json.data.user_name === 'Aya Partner' && r.json.data.branch_name === `Ownership e2e ${stamp}`, `${r.status}`);
const own1 = r.json?.data?.id;

r = await call('POST', '/ownerships', { user_id: u2, percentage: 50, branch_scope: branchId }, admin);
chk('a further 50% would make 110% → refused 422', r.status === 422 && r.json?.data?.message_key === 'ownership_sum_exceeded', `${r.status}`);

r = await call('POST', '/ownerships', { user_id: u2, percentage: 40, branch_scope: branchId }, admin);
chk('…40% (exactly 100%) is accepted', r.status === 201, `${r.status}`);
const own2 = r.json?.data?.id;

r = await call('POST', '/ownerships', { user_id: u3, percentage: 0.01, branch_scope: branchId }, admin);
chk('a full pool refuses even 0.01%', r.status === 422, `${r.status}`);

r = await call('GET', `/ownerships?branch_scope=${branchId}`, null, admin);
const rows = r.json?.data ?? [];
chk('branch filter lists exactly the two active shares, largest first', rows.length === 2 && rows[0].percentage === 60 && rows[1].percentage === 40, `${rows.length}`);

r = await call('GET', '/ownerships', null, admin);
chk('unfiltered list includes them too (all scopes)', (r.json?.data ?? []).filter((x) => x.branch_scope === branchId).length === 2);

// ── revise: history kept, cap excludes the record being replaced ─────────────
r = await call('POST', `/ownerships/${own1}/revise`, { percentage: 70 }, admin);
chk('60→70 with 40 beside it = 110% → refused', r.status === 422, `${r.status}`);
r = await call('POST', `/ownerships/${own1}/revise`, { percentage: 55 }, admin);
chk('60→55 accepted (own old share is not double-counted)', r.status === 200 && r.json.data.percentage === 55 && r.json.data.id !== own1, `${r.status}`);
const own1b = r.json?.data?.id;
r = await call('GET', `/ownerships?branch_scope=${branchId}`, null, admin);
chk('the old record left the active list; the new one is there', !(r.json.data ?? []).some((x) => x.id === own1) && (r.json.data ?? []).some((x) => x.id === own1b));
r = await call('POST', `/ownerships/${own1}/revise`, { percentage: 50 }, admin);
chk('revising an already-closed record → 404', r.status === 404, `${r.status}`);

// ── end ──────────────────────────────────────────────────────────────────────
r = await call('POST', `/ownerships/${own2}/end`, null, admin);
chk('ending a share succeeds', r.status === 200, `${r.status}`);
r = await call('POST', `/ownerships/${own2}/end`, null, admin);
chk('…and ending it twice → 404', r.status === 404, `${r.status}`);
r = await call('POST', '/ownerships', { user_id: u3, percentage: 45, branch_scope: branchId }, admin);
chk('the freed 40% can be given to someone else (45 fits beside 55)', r.status === 201, `${r.status}`);
const own3 = r.json?.data?.id;

// ── who may see it ───────────────────────────────────────────────────────────
r = await call('POST', '/users/login', { email: `own.aya.${stamp}@example.com`, password: 'Passw0rd!x' });
const partnerToken = r.json?.data?.token;
r = await call('GET', '/ownerships', null, partnerToken);
chk('a financial partner (no ownerships.manage) cannot read the share list → 403', r.status === 403 || r.status === 401, `${r.status}`);
r = await call('GET', '/ownerships');
chk('a guest cannot either → 401', r.status === 401, `${r.status}`);

// ── audit ────────────────────────────────────────────────────────────────────
r = await call('GET', `/audit-log?target_entity=ownership:${own1b}`, null, admin);
const actions = (r.json?.data?.items ?? []).map((x) => x.action);
chk('the revise is in the audit log', actions.includes('ownership.revise'), actions.join(','));

// ── clean up: close what this run opened ─────────────────────────────────────
for (const id of [own1b, own3]) await call('POST', `/ownerships/${id}/end`, null, admin);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
