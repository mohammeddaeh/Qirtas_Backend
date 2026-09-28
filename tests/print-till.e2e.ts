/**
 * End-to-end: paying a print order **as a line on the till invoice** (slice
 * 9-ج-3) — add by number, the clock stops, remove/void restarts it, paying
 * settles the order in the same transaction, a refused settlement refuses the
 * whole invoice, and deferral with approval.
 *
 *   docker compose up -d postgres
 *   npx tsx tests/print-till.e2e.ts
 *
 * Same harness as print-jobs.e2e.ts (in-process app, local storage, seeded
 * super admin, customers verified in the database). Orders are sent with a
 * link, not a file: files are proven in print-jobs.e2e.ts.
 */
process.env['STORAGE_SIGNING_KEY'] ??= 'e2e-signing-key-'.padEnd(40, 'x');
process.env['MAIL_TRANSPORT'] ??= 'log';
process.env['LOG_LEVEL'] ??= 'error';

const { readFileSync } = await import('node:fs');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { eq } = await import('drizzle-orm');
const { buildApp } = await import('../src/app.js');
const { configureMedia, urlSigner } = await import('../src/core/media/composition.js');
const { LocalDiskDriver } = await import('../src/core/media/adapters/local-disk.driver.js');
const { db, pool } = await import('../src/core/db/client.js');
const { customersTable } = await import('../src/features/customers/schemas/customers.schema.js');
const { printJobsTable } = await import('../src/features/printing/schemas/print-jobs.schema.js');

const adminPassword = /^SEED_ADMIN_PASSWORD=(.*)$/m.exec(readFileSync('.env', 'utf8'))?.[1]?.trim();
if (!adminPassword) {
  console.error('SEED_ADMIN_PASSWORD missing from .env');
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), 'qirtas-till-e2e-'));
const app = buildApp();
configureMedia(new LocalDiskDriver(root, urlSigner()));
const server = app.listen(0);
const B = `http://localhost:${(server.address() as { port: number }).port}/api/v1`;

let pass = 0;
let fail = 0;
const chk = (name: string, ok: boolean, extra = ''): void => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  [${extra}]` : ''}`);
};

type Json = { data?: any; message_key?: string } | null; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Json }> {
  const r = await fetch(B + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as Json };
}
const keyOf = (r: { json: Json }): string | undefined =>
  r.json?.data?.message_key ?? r.json?.message_key;

const login = await call('POST', '/users/login', {
  email: 'super_admin@admin.com',
  password: adminPassword,
});
const ST = (login.json?.data?.token ?? login.json?.data?.access_token) as string;

async function newCustomer(tag: string): Promise<{ token: string; id: number }> {
  const email = `e2e_till_${tag}_${Date.now()}@qirtas.test`;
  const reg = await call('POST', '/customers/register', {
    accept_terms: true,
    first_name: 'صندوق',
    last_name: tag,
    email,
    password: 'Till-e2e-Passw0rd!',
  });
  await db
    .update(customersTable)
    .set({ email_verified_at: new Date() })
    .where(eq(customersTable.email, email));
  return { token: reg.json?.data?.token as string, id: reg.json?.data?.customer?.id as number };
}
const owner = await newCustomer('owner');
const other = await newCustomer('other');
const CT = owner.token;

const cfg = (await call('GET', '/printing/config', undefined, ST)).json?.data;
const byCode = (kind: string, code: string): number =>
  cfg.options.find((o: { kind: string; code: string }) => o.kind === kind && o.code === code).id;
const spec = {
  paper_size_id: byCode('paper_size', 'a4'),
  color_mode_id: byCode('color_mode', 'bw'),
  sides_id: byCode('sides', 'single'),
  binding_id: byCode('binding', 'spiral'),
  cover_id: byCode('cover', 'none'),
};
const branchId = 1;

/** A priced order: link → submit → staff enter pages. */
async function pricedJob(
  pages: number,
  branch = branchId,
): Promise<{ id: number; number: string; total: number }> {
  const j = (await call('POST', '/print-jobs', { branch_id: branch, copies: 1, ...spec }, CT)).json
    ?.data;
  await call('POST', `/print-jobs/${j.id}/links`, { url: 'https://example.com/doc.pdf' }, CT);
  await call('POST', `/print-jobs/${j.id}/submit`, undefined, CT);
  const q = (await call('POST', `/printing/jobs/${j.id}/quote`, { pages }, ST)).json?.data;
  return { id: j.id, number: q.number, total: q.quoted_total_syp };
}
const openSale = async (customerId?: number, branch = branchId) =>
  (
    await call(
      'POST',
      '/sales',
      { branch_id: branch, ...(customerId ? { customer_id: customerId } : {}) },
      ST,
    )
  ).json?.data;
const addJob = (saleId: number, reference: string) =>
  call('POST', `/sales/${saleId}/services`, { kind: 'print_job', reference }, ST);
const staffJob = async (id: number) =>
  (await call('GET', `/printing/jobs/${id}`, undefined, ST)).json?.data;

// ── add by number ──
const A = await pricedJob(10);
const s1 = await openSale();
const unknown = await addJob(s1.id, 'BR1-P-2026-999999');
chk(
  'an unknown number is refused',
  unknown.status === 404 && keyOf(unknown) === 'print_job_not_found',
  String(keyOf(unknown)),
);
const added = await addJob(s1.id, A.number.toLowerCase());
const line = added.json?.data?.lines?.[0];
chk(
  'the order is added by its number (case-insensitive)',
  added.status === 200 && line?.service?.kind === 'print_job' && line?.service?.ref_id === A.id,
  String(added.status),
);
chk(
  'the line is a service: no variant, qty 1, the quoted amount',
  line?.variant_id === null && line?.qty === 1 && line?.unit_price_syp === A.total,
  JSON.stringify({ v: line?.variant_id, p: line?.unit_price_syp, t: A.total }),
);
chk('the invoice is put in the customer’s name', added.json?.data?.customer_id === owner.id);
const twice = await addJob(s1.id, String(A.id));
chk('adding it again (by id) does not add a second line', twice.json?.data?.lines?.length === 1);

let a = await staffJob(A.id);
chk(
  'at the till: the clock stops',
  a.at_till === true && a.payment_due_at === null && a.hours_left === null,
);
const cancelAtTill = await call('POST', `/print-jobs/${A.id}/cancel`, {}, CT);
chk(
  'the customer cannot cancel it while at the till',
  cancelAtTill.status === 409 && keyOf(cancelAtTill) === 'print_job_at_till',
  String(keyOf(cancelAtTill)),
);
const requote = await call('POST', `/printing/jobs/${A.id}/quote`, { pages: 99 }, ST);
chk(
  'staff cannot re-price it while at the till',
  requote.status === 409 && keyOf(requote) === 'print_job_at_till',
  String(keyOf(requote)),
);
const s2 = await openSale();
const elsewhere = await addJob(s2.id, A.number);
chk(
  'another basket cannot take it too',
  elsewhere.status === 409 && keyOf(elsewhere) === 'print_job_in_other_sale',
  String(keyOf(elsewhere)),
);
const qty = await call('PATCH', `/sales/${s1.id}/lines/${line.id}`, { qty: 3 }, ST);
chk(
  'a service line’s quantity is fixed',
  qty.status === 409 && keyOf(qty) === 'sale_service_qty_fixed',
  String(keyOf(qty)),
);
const wrongCustomer = await openSale(other.id);
const mismatch = await addJob(wrongCustomer.id, String((await pricedJob(2)).id));
chk(
  'a basket in another customer’s name is refused',
  mismatch.status === 409 && keyOf(mismatch) === 'sale_service_other_customer',
  String(keyOf(mismatch)),
);

// ── remove and void give the clock back ──
await call('DELETE', `/sales/${s1.id}/lines/${line.id}`, undefined, ST);
a = await staffJob(A.id);
chk(
  'removed from the basket: back to waiting, with a fresh 3-day deadline',
  a.at_till === false && a.sale_id === null && a.hours_left === 72,
  String(a.hours_left),
);
await addJob(s2.id, A.number);
await call('POST', `/sales/${s2.id}/void`, {}, ST);
a = await staffJob(A.id);
chk(
  'basket voided: back to waiting too',
  a.at_till === false && a.hours_left === 72 && a.status === 'awaiting_payment',
);

// ── a refused settlement refuses the whole invoice ──
const s3 = await openSale();
await addJob(s3.id, A.number);
await db.update(printJobsTable).set({ status: 'cancelled' }).where(eq(printJobsTable.id, A.id));
const refused = await call(
  'POST',
  `/sales/${s3.id}/pay`,
  { payments: [{ method: 'cash', amount_syp: A.total, tendered_syp: A.total }] },
  ST,
);
const s3After = (await call('GET', `/sales/${s3.id}`, undefined, ST)).json?.data;
chk(
  'paying for an order cancelled meanwhile is refused',
  refused.status === 409 && keyOf(refused) === 'print_job_not_payable',
  String(keyOf(refused)),
);
chk(
  '…and the invoice was not paid (one transaction)',
  s3After?.status === 'open' && s3After?.number === null,
  s3After?.status,
);
await db
  .update(printJobsTable)
  .set({ status: 'awaiting_payment' })
  .where(eq(printJobsTable.id, A.id));

// ── pay ──
const paid = await call(
  'POST',
  `/sales/${s3.id}/pay`,
  { payments: [{ method: 'cash', amount_syp: A.total, tendered_syp: A.total }] },
  ST,
);
chk(
  'the invoice is paid',
  paid.json?.data?.status === 'paid' && typeof paid.json?.data?.number === 'string',
  String(keyOf(paid) ?? paid.status),
);
a = await staffJob(A.id);
chk(
  'the order is paid and queued, bridged to its invoice',
  a.payment_status === 'paid' &&
    a.status === 'queued' &&
    a.sale_id === s3.id &&
    a.paid_at !== null &&
    a.at_till === false,
);
const again = await addJob((await openSale()).id, A.number);
chk(
  'a paid order cannot be collected twice',
  again.status === 409 && keyOf(again) === 'print_job_not_payable',
  String(keyOf(again)),
);
const prod = await call('POST', `/printing/jobs/${A.id}/status`, { status: 'in_production' }, ST);
chk('paid → production opens', prod.json?.data?.status === 'in_production');
const returnable = await call('GET', `/sales/${s3.id}/returnable`, undefined, ST);
chk(
  'the service line is not offered for return (no shelf to return it to)',
  returnable.status === 200 && returnable.json?.data?.lines?.length === 0,
  String(returnable.json?.data?.lines?.length),
);

// ── a service beside goods on one invoice ──
// Any branch that holds priced stock: the point is that paying issues the goods
// line and skips the service line, in one transaction.
const stocked = await pool.query<{ branch_id: number; sku: string }>(
  `SELECT sb.branch_id, v.sku FROM stock_balances sb
     JOIN catalog_variants v ON v.id = sb.variant_id
     JOIN branches b ON b.id = sb.branch_id AND b.status = 'active' AND b.archived_at IS NULL
    WHERE sb.on_hand >= 1 ORDER BY sb.on_hand DESC LIMIT 20`,
);
const itemsPath = (branch: number, sku: string) => `/sales/items?branch_id=${branch}&search=${sku}`;
let mixedDone = false;
for (const row of stocked.rows) {
  const found =
    (await call('GET', itemsPath(row.branch_id, row.sku), undefined, ST)).json?.data ?? [];
  const item = (found as { variant_id: number; price_syp: number | null; on_hand: number }[]).find(
    (i) => i.price_syp !== null && i.on_hand >= 1,
  );
  if (!item) continue;
  const before = item.on_hand;
  const C = await pricedJob(4, row.branch_id);
  const s4 = await openSale(undefined, row.branch_id);
  await call('POST', `/sales/${s4.id}/lines`, { variant_id: item.variant_id, qty: 1 }, ST);
  const mixed = (await addJob(s4.id, C.number)).json?.data;
  const total = mixed?.total_syp;
  const paidMixed = await call(
    'POST',
    `/sales/${s4.id}/pay`,
    { payments: [{ method: 'cash', amount_syp: total, tendered_syp: total }] },
    ST,
  );
  chk(
    'goods and a print order on one invoice, paid once',
    paidMixed.json?.data?.status === 'paid' && mixed?.lines?.length === 2,
    String(keyOf(paidMixed) ?? ''),
  );
  chk('…and the order is settled with it', (await staffJob(C.id)).payment_status === 'paid');
  const after = (
    (await call('GET', itemsPath(row.branch_id, row.sku), undefined, ST)).json?.data ?? []
  ).find((i: { variant_id: number }) => i.variant_id === item.variant_id);
  chk(
    '…the goods left the shelf, and the service moved nothing',
    after?.on_hand === before - 1,
    `${before} → ${after?.on_hand}`,
  );
  mixedDone = true;
  break;
}
if (!mixedDone)
  console.log('ℹ️  no priced item with stock at an active branch — mixed-invoice check skipped');

// ── deferral ──
const D = await pricedJob(6);
const noReason = await call('POST', `/printing/jobs/${D.id}/defer`, {}, ST);
chk('deferring needs a reason', noReason.status === 422, String(noReason.status));
const deferred = await call(
  'POST',
  `/printing/jobs/${D.id}/defer`,
  { reason: 'زبون جملة موثوق' },
  ST,
);
chk(
  'deferred: queued, unpaid-by-approval, named',
  deferred.json?.data?.status === 'queued' &&
    deferred.json?.data?.payment_status === 'deferred' &&
    deferred.json?.data?.deferred?.reason === 'زبون جملة موثوق' &&
    typeof deferred.json?.data?.deferred?.by === 'number',
);
const deferTwice = await call('POST', `/printing/jobs/${D.id}/defer`, { reason: 'مرة ثانية' }, ST);
chk('deferring twice is refused', deferTwice.status === 409, String(deferTwice.status));
const dProd = await call('POST', `/printing/jobs/${D.id}/status`, { status: 'in_production' }, ST);
chk('deferred → production opens without payment', dProd.json?.data?.status === 'in_production');
await call('POST', `/printing/jobs/${D.id}/status`, { status: 'ready' }, ST);
const s5 = await openSale();
await addJob(s5.id, D.number);
await call(
  'POST',
  `/sales/${s5.id}/pay`,
  { payments: [{ method: 'cash', amount_syp: D.total, tendered_syp: D.total }] },
  ST,
);
const d = await staffJob(D.id);
chk(
  'the deferred debt is paid at pickup — stage unchanged, payment settled',
  d.payment_status === 'paid' && d.status === 'ready' && d.deferred !== null,
);

server.close();
await rm(root, { recursive: true, force: true });
await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
