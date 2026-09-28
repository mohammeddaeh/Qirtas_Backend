/**
 * End-to-end: a print order over HTTP — draft → files (reserve · direct PUT ·
 * complete) → links → submit → staff prices by page count → payment gate →
 * stages → retention, plus the unpaid deadline and who may see what.
 *
 *   docker compose up -d postgres
 *   npx tsx tests/print-jobs.e2e.ts
 *
 * Boots the app in-process on an ephemeral port with the **local** storage
 * driver in a temp directory (the S3 path is proven by media-documents.e2e.ts).
 * Staff = the seeded super admin (`SEED_ADMIN_PASSWORD` from `.env`). Customers
 * are registered for the run; their email is marked verified in the database —
 * the code flow has its own suite (customer-accounts.e2e.mjs).
 *
 * The payment itself is slice 9-ج-3 (a line on the POS invoice). Until then the
 * gate is exercised by writing `queued`/`paid` straight to the row — the point
 * is that production refuses an unpaid job whatever its status says.
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
const { printJobsTable, printJobFilesTable } =
  await import('../src/features/printing/schemas/print-jobs.schema.js');
const { mediaAssetsTable } = await import('../src/core/media/schemas/media-assets.schema.js');

const adminPassword = /^SEED_ADMIN_PASSWORD=(.*)$/m.exec(readFileSync('.env', 'utf8'))?.[1]?.trim();
if (!adminPassword) {
  console.error('SEED_ADMIN_PASSWORD missing from .env');
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), 'qirtas-print-e2e-'));
const app = buildApp();
configureMedia(new LocalDiskDriver(root, urlSigner()));
const server = app.listen(0);
const ORIGIN = `http://localhost:${(server.address() as { port: number }).port}`;
const B = `${ORIGIN}/api/v1`;

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

async function upload(
  target: { url: string; headers: Record<string, string> },
  bytes: Buffer,
): Promise<number> {
  const r = await fetch(ORIGIN + target.url, {
    method: 'PUT',
    headers: target.headers,
    body: bytes,
  });
  await r.arrayBuffer();
  return r.status;
}

async function newCustomer(tag: string, verified: boolean): Promise<string> {
  const email = `e2e_print_${tag}_${Date.now()}@qirtas.test`;
  const reg = await call('POST', '/customers/register', {
    accept_terms: true,
    first_name: 'طباعة',
    last_name: tag,
    email,
    password: 'Print-e2e-Passw0rd!',
  });
  const token = reg.json?.data?.token as string;
  if (verified) {
    await db
      .update(customersTable)
      .set({ email_verified_at: new Date() })
      .where(eq(customersTable.email, email));
  }
  return token;
}

// ── actors ──
const login = await call('POST', '/users/login', {
  email: 'super_admin@admin.com',
  password: adminPassword,
});
const ST = (login.json?.data?.token ?? login.json?.data?.access_token) as string;
chk('staff signs in', typeof ST === 'string', String(login.status));
const CT = await newCustomer('owner', true);
const OT = await newCustomer('other', true);
const UT = await newCustomer('unverified', false);

// ── prices (same values as the 9-أ run, so the dev database is unchanged) ──
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
await call(
  'PUT',
  '/printing/rates',
  {
    page_rates: [
      {
        paper_size_id: spec.paper_size_id,
        color_mode_id: spec.color_mode_id,
        sides_id: spec.sides_id,
        amount_syp: 100,
      },
    ],
    finishing_rates: [
      { option_id: spec.binding_id, amount_syp: 3000 },
      { option_id: spec.cover_id, amount_syp: 0 },
    ],
  },
  ST,
);
const branchId = 1;

// ── create ──
const unverified = await call(
  'POST',
  '/print-jobs',
  { branch_id: branchId, copies: 2, ...spec },
  UT,
);
chk(
  'an unverified customer cannot open a print order',
  unverified.status === 403 && keyOf(unverified) === 'email_verification_required',
  String(keyOf(unverified)),
);
const wrongKind = await call(
  'POST',
  '/print-jobs',
  { branch_id: branchId, copies: 2, ...spec, cover_id: spec.binding_id },
  CT,
);
chk(
  'a binding sent as the cover is refused at once',
  wrongKind.status === 422 && keyOf(wrongKind) === 'print_option_wrong_kind',
  String(keyOf(wrongKind)),
);
const created = await call(
  'POST',
  '/print-jobs',
  { branch_id: branchId, copies: 2, note: 'الصفحات كلها', ...spec },
  CT,
);
const job = created.json?.data;
chk(
  'a verified customer opens a draft',
  created.status === 201 && job?.status === 'draft' && job?.number === null,
  String(created.status),
);
chk('the draft names its spec', job?.spec?.binding?.code === 'spiral' && job?.copies === 2);
chk(
  'next_states of a draft',
  JSON.stringify(job?.next_states) === JSON.stringify(['awaiting_quote', 'cancelled']),
);
const J = `/print-jobs/${job.id}`;

// ── ownership ──
const peek = await call('GET', J, undefined, OT);
chk(
  "another customer's order is not found (404, not 403)",
  peek.status === 404,
  String(peek.status),
);
const staffSeesDraft = await call('GET', `/printing/jobs/${job.id}`, undefined, ST);
chk(
  'staff do not see a draft (it is nobody’s work yet)',
  staffSeesDraft.status === 404,
  String(staffSeesDraft.status),
);

// ── submit refusals ──
const empty = await call('POST', `${J}/submit`, undefined, CT);
chk(
  'an empty draft cannot be sent',
  empty.status === 422 && keyOf(empty) === 'print_job_nothing_to_print',
  String(keyOf(empty)),
);

// ── files ──
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 0x20)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2046)]);
const tooBig = await call(
  'POST',
  `${J}/files`,
  { filename: 'كبير.pdf', bytes: 51 * 1024 * 1024 },
  CT,
);
chk(
  'a 51 MB file is refused before upload',
  tooBig.status === 422 && keyOf(tooBig) === 'document_too_large',
  String(keyOf(tooBig)),
);
const exeName = await call('POST', `${J}/files`, { filename: 'setup.exe', bytes: 100 }, CT);
chk(
  'an .exe name is refused before upload',
  exeName.status === 422 && keyOf(exeName) === 'document_type_not_allowed',
  String(keyOf(exeName)),
);

const r1 = await call('POST', `${J}/files`, { filename: 'بحث التخرج.pdf', bytes: PDF.length }, CT);
chk(
  'reserving a PDF returns an upload link',
  r1.status === 201 &&
    r1.json?.data?.upload?.method === 'PUT' &&
    r1.json?.data?.file?.status === 'pending',
);
const f1 = r1.json?.data?.file?.id as number;
chk('the upload lands', (await upload(r1.json?.data?.upload, PDF)) === 204);
const early = await call('POST', `${J}/submit`, undefined, CT);
chk(
  'cannot send while a file is uploaded but not confirmed',
  early.status === 409 && keyOf(early) === 'print_job_files_uploading',
  String(keyOf(early)),
);
const done = await call('POST', `${J}/files/${f1}/complete`, undefined, CT);
const doneFile = done.json?.data?.files?.find((f: { id: number }) => f.id === f1);
chk(
  'complete → ready, typed from the bytes',
  doneFile?.status === 'ready' && doneFile?.type === 'pdf',
  JSON.stringify(doneFile),
);

const r2 = await call('POST', `${J}/files`, { filename: 'invoice.pdf', bytes: EXE.length }, CT);
await upload(r2.json?.data?.upload, EXE);
const evil = await call('POST', `${J}/files/${r2.json?.data?.file?.id}/complete`, undefined, CT);
chk(
  'an executable named invoice.pdf is rejected',
  evil.json?.data?.files?.some((f: { status: string }) => f.status === 'rejected'),
);
const blocked = await call('POST', `${J}/submit`, undefined, CT);
chk(
  'a rejected file blocks sending',
  blocked.status === 409 && keyOf(blocked) === 'print_job_files_unusable',
  String(keyOf(blocked)),
);
const removed = await call('DELETE', `${J}/files/${r2.json?.data?.file?.id}`, undefined, CT);
chk('the customer removes it', removed.status === 200 && removed.json?.data?.files?.length === 1);

const otherLink = await call('GET', `${J}/files/${f1}/link`, undefined, OT);
chk(
  'another customer cannot get a link to the file',
  otherLink.status === 404,
  String(otherLink.status),
);
const myLink = await call('GET', `${J}/files/${f1}/link`, undefined, CT);
const myBytes = Buffer.from(await (await fetch(ORIGIN + myLink.json?.data?.url)).arrayBuffer());
chk('the owner reads the file back', myBytes.equals(PDF));

// ── links ──
const http = await call('POST', `${J}/links`, { url: 'http://example.com/a.pdf' }, CT);
chk(
  'an http link is refused',
  http.status === 422 && keyOf(http) === 'print_link_invalid',
  String(keyOf(http)),
);
const https = await call(
  'POST',
  `${J}/links`,
  { url: 'https://drive.google.com/file/d/abc/view', note: 'الفصل الثاني' },
  CT,
);
chk(
  'an https link is stored as text',
  https.status === 200 && https.json?.data?.links?.length === 1,
);

// ── submit ──
const sent = await call('POST', `${J}/submit`, undefined, CT);
chk(
  'sent → awaiting_quote with a number',
  sent.json?.data?.status === 'awaiting_quote' &&
    /-P-\d{4}-\d{6}$/.test(sent.json?.data?.number ?? ''),
  sent.json?.data?.number,
);
const edit = await call('PATCH', J, { copies: 5 }, CT);
chk(
  'a sent order can no longer be edited',
  edit.status === 409 && keyOf(edit) === 'print_job_not_editable',
  String(keyOf(edit)),
);

// ── staff ──
const customerOnQueue = await call('GET', `/printing/jobs?branch_id=${branchId}`, undefined, CT);
chk(
  'a customer token cannot read the queue',
  customerOnQueue.status === 401 || customerOnQueue.status === 403,
  String(customerOnQueue.status),
);
const branches = await call('GET', '/printing/jobs/branches', undefined, ST);
chk(
  'the queue branch picker lists the branches the reader holds the key at',
  Array.isArray(branches.json?.data) && branches.json?.data.some((b: { id: number }) => b.id === branchId),
);
const customerBranches = await call('GET', '/printing/jobs/branches', undefined, CT);
chk('…and refuses a customer', customerBranches.status === 401 || customerBranches.status === 403, String(customerBranches.status));
const queue = await call(
  'GET',
  `/printing/jobs?branch_id=${branchId}&status=awaiting_quote,awaiting_payment`,
  undefined,
  ST,
);
chk(
  'the queue lists the sent order',
  queue.json?.data?.items?.some((j: { id: number }) => j.id === job.id),
);
const early2 = await call(
  'POST',
  `/printing/jobs/${job.id}/status`,
  { status: 'in_production' },
  ST,
);
chk(
  'no production before pricing',
  early2.status === 409 && keyOf(early2) === 'print_job_wrong_status',
  String(keyOf(early2)),
);

const staffLink = await call('GET', `/printing/jobs/${job.id}/files/${f1}/link`, undefined, ST);
const staffBytes = Buffer.from(
  await (await fetch(ORIGIN + staffLink.json?.data?.url)).arrayBuffer(),
);
chk('staff open the file', staffBytes.equals(PDF));

const q = await call('POST', `/printing/jobs/${job.id}/quote`, { pages: 50 }, ST);
// 50 pages × 2 copies × 100 = 10 000, + spiral 3000 × 2 = 6000 (no tier below 100 printed pages… 100 = tier 10%)
const expected = q.json?.data?.quote?.total_syp;
chk(
  'staff enter the pages; the server prices',
  q.json?.data?.status === 'awaiting_payment' &&
    q.json?.data?.total_pages === 50 &&
    q.json?.data?.quoted_total_syp === expected &&
    typeof expected === 'number',
  String(expected),
);
chk(
  'the price carries its breakdown (same shape as /printing/quote)',
  q.json?.data?.quote?.printed_pages === 100 && q.json?.data?.quote?.copies === 2,
);
chk('three days to pay', q.json?.data?.hours_left === 72, String(q.json?.data?.hours_left));
const q2 = await call('POST', `/printing/jobs/${job.id}/quote`, { pages: 40 }, ST);
chk(
  'a miscount is re-priced before payment',
  q2.json?.data?.total_pages === 40 && q2.json?.data?.quoted_total_syp !== expected,
);

const unpaidProd = await call(
  'POST',
  `/printing/jobs/${job.id}/status`,
  { status: 'in_production' },
  ST,
);
chk(
  'an unpaid order does not reach production',
  unpaidProd.status === 409,
  String(keyOf(unpaidProd)),
);

// A row forced to `queued` without payment must still be refused.
await db.update(printJobsTable).set({ status: 'queued' }).where(eq(printJobsTable.id, job.id));
const forged = await call(
  'POST',
  `/printing/jobs/${job.id}/status`,
  { status: 'in_production' },
  ST,
);
chk(
  'queued but unpaid → refused by the payment gate itself',
  forged.status === 409 && keyOf(forged) === 'print_job_unpaid',
  String(keyOf(forged)),
);
const noCancelPaid = await call('POST', `${J}/cancel`, {}, CT);
chk(
  'the customer cannot cancel once queued',
  noCancelPaid.status === 409 && keyOf(noCancelPaid) === 'print_job_not_cancellable',
  String(keyOf(noCancelPaid)),
);

await db
  .update(printJobsTable)
  .set({ payment_status: 'paid' })
  .where(eq(printJobsTable.id, job.id));
const prod = await call('POST', `/printing/jobs/${job.id}/status`, { status: 'in_production' }, ST);
chk(
  'paid → production starts',
  prod.json?.data?.status === 'in_production' && prod.json?.data?.production_started_at !== null,
);
const skip = await call('POST', `/printing/jobs/${job.id}/status`, { status: 'picked_up' }, ST);
chk('cannot skip ready', skip.status === 409, String(skip.status));
await call('POST', `/printing/jobs/${job.id}/status`, { status: 'ready' }, ST);
const picked = await call('POST', `/printing/jobs/${job.id}/status`, { status: 'picked_up' }, ST);
chk(
  'ready → picked up, next_states empty',
  picked.json?.data?.status === 'picked_up' && picked.json?.data?.next_states?.length === 0,
);
const [fileAsset] = await db
  .select({ expires_at: mediaAssetsTable.expires_at })
  .from(printJobFilesTable)
  .innerJoin(mediaAssetsTable, eq(mediaAssetsTable.id, printJobFilesTable.media_asset_id))
  .where(eq(printJobFilesTable.job_id, job.id));
const days = fileAsset?.expires_at
  ? Math.round((fileAsset.expires_at.getTime() - Date.now()) / 86_400_000)
  : null;
chk('files are kept 30 days after pickup', days === 30, String(days));

// ── the unpaid deadline ──
const j2 = (await call('POST', '/print-jobs', { branch_id: branchId, copies: 1, ...spec }, CT)).json
  ?.data;
await call('POST', `/print-jobs/${j2.id}/links`, { url: 'https://example.com/flyer.pdf' }, CT);
await call('POST', `/print-jobs/${j2.id}/submit`, undefined, CT);
await call('POST', `/printing/jobs/${j2.id}/quote`, { pages: 3 }, ST);
await db
  .update(printJobsTable)
  .set({ payment_due_at: new Date(Date.now() - 1000) })
  .where(eq(printJobsTable.id, j2.id));
const lapsed = await call('GET', `/print-jobs/${j2.id}`, undefined, CT);
chk(
  'an unpaid order past its deadline reads expired (swept on read)',
  lapsed.json?.data?.status === 'expired' && lapsed.json?.data?.hours_left === null,
  lapsed.json?.data?.status,
);

// ── cancellations ──
const j3 = (await call('POST', '/print-jobs', { branch_id: branchId, copies: 1, ...spec }, CT)).json
  ?.data;
await call('POST', `/print-jobs/${j3.id}/links`, { url: 'https://example.com/b.pdf' }, CT);
await call('POST', `/print-jobs/${j3.id}/submit`, undefined, CT);
const noReason = await call('POST', `/printing/jobs/${j3.id}/cancel`, {}, ST);
chk('staff must give the customer a reason', noReason.status === 422, String(noReason.status));
const staffCancel = await call(
  'POST',
  `/printing/jobs/${j3.id}/cancel`,
  { reason: 'الرابط لا يفتح' },
  ST,
);
chk(
  'staff cancel with a reason the customer sees',
  staffCancel.json?.data?.status === 'cancelled' &&
    staffCancel.json?.data?.cancel_reason === 'الرابط لا يفتح',
);

const j4 = (await call('POST', '/print-jobs', { branch_id: branchId, copies: 1, ...spec }, CT)).json
  ?.data;
const mine = await call('POST', `/print-jobs/${j4.id}/cancel`, {}, CT);
chk('the customer cancels a draft', mine.json?.data?.status === 'cancelled');
const again = await call('POST', `/print-jobs/${j4.id}/cancel`, {}, CT);
chk('cancelling twice is refused, not repeated', again.status === 409, String(again.status));

const list = await call('GET', '/print-jobs?status=cancelled,expired', undefined, CT);
chk(
  'my orders filter by several statuses',
  list.json?.data?.items?.length === 3 &&
    list.json?.data?.items?.every((j: { status: string }) =>
      ['cancelled', 'expired'].includes(j.status),
    ),
  String(list.json?.data?.items?.length),
);
const othersList = await call('GET', '/print-jobs', undefined, OT);
chk("another customer's list is empty", othersList.json?.data?.items?.length === 0);

server.close();
await rm(root, { recursive: true, force: true });
await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
