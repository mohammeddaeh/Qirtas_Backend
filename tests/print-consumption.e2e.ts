/**
 * End-to-end: the consumption recipe on a real ledger (slice 9-هـ) — a job
 * starting to print takes its paper by sheets, its binding by copy and its ink
 * by yield, in the same transaction; the job carries its materials cost and
 * profit (for those who set prices only); «a new cartridge was installed»
 * reconciles the estimate with reality.
 *
 *   docker compose up -d postgres
 *   npx tsx tests/print-consumption.e2e.ts
 *
 * Runs at an active branch that holds stock, using three of its stocked items
 * as stand-in materials. The recipe is restored at the end; the stock
 * movements stay in the dev ledger (they are real movements, as intended).
 */
process.env['STORAGE_SIGNING_KEY'] ??= 'e2e-signing-key-'.padEnd(40, 'x');
process.env['MAIL_TRANSPORT'] ??= 'log';
process.env['LOG_LEVEL'] ??= 'error';

const { readFileSync } = await import('node:fs');
const { eq } = await import('drizzle-orm');
const { buildApp } = await import('../src/app.js');
const { db, pool } = await import('../src/core/db/client.js');
const { customersTable } = await import('../src/features/customers/schemas/customers.schema.js');

const adminPassword = /^SEED_ADMIN_PASSWORD=(.*)$/m.exec(readFileSync('.env', 'utf8'))?.[1]?.trim();
if (!adminPassword) {
  console.error('SEED_ADMIN_PASSWORD missing from .env');
  process.exit(2);
}
const app = buildApp();
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
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

const ST = (
  await call('POST', '/users/login', { email: 'super_admin@admin.com', password: adminPassword })
).json?.data?.token as string;
const email = `e2e_consume_${Date.now()}@qirtas.test`;
const reg = await call('POST', '/customers/register', {
  accept_terms: true,
  first_name: 'استهلاك',
  last_name: 'تجربة',
  email,
  password: 'Consume-e2e-Passw0rd!',
});
await db
  .update(customersTable)
  .set({ email_verified_at: new Date() })
  .where(eq(customersTable.email, email));
const CT = reg.json?.data?.token as string;

// ── a branch with three stocked items to stand in for paper, toner and wire ──
const stocked = await pool.query<{ branch_id: number; variant_id: number }>(
  `SELECT sb.branch_id, sb.variant_id FROM stock_balances sb
     JOIN branches b ON b.id = sb.branch_id AND b.status = 'active' AND b.archived_at IS NULL
    WHERE sb.on_hand >= 5 ORDER BY sb.branch_id, sb.on_hand DESC`,
);
const byBranch = new Map<number, number[]>();
for (const r of stocked.rows)
  byBranch.set(r.branch_id, [...(byBranch.get(r.branch_id) ?? []), r.variant_id]);
const [branchId, variants] = [...byBranch.entries()].find(([, v]) => v.length >= 3) ?? [null, []];
if (branchId === null) {
  console.error('No active branch with three stocked items — nothing to consume');
  process.exit(2);
}
const [PAPER, TONER, WIRE] = variants as [number, number, number];
const balance = async (variantId: number): Promise<number> =>
  Number(
    (
      await pool.query<{ on_hand: string }>(
        'SELECT on_hand FROM stock_balances WHERE branch_id=$1 AND variant_id=$2',
        [branchId, variantId],
      )
    ).rows[0]?.on_hand ?? 0,
  );

const cfg = (await call('GET', '/printing/config', undefined, ST)).json?.data;
const byCode = (kind: string, code: string): number =>
  cfg.options.find((o: { kind: string; code: string }) => o.kind === kind && o.code === code).id;
const A4 = byCode('paper_size', 'a4');
const BW = byCode('color_mode', 'bw');
const DOUBLE = byCode('sides', 'double');
const SINGLE = byCode('sides', 'single');
const SPIRAL = byCode('binding', 'spiral');
const NO_COVER = byCode('cover', 'none');
// Prices for the double-sided cell (the 9-أ run priced single only).
await call(
  'PUT',
  '/printing/rates',
  { page_rates: [{ paper_size_id: A4, color_mode_id: BW, sides_id: DOUBLE, amount_syp: 80 }] },
  ST,
);

// ── the recipe ──
const before = (await call('GET', '/printing/consumption-rules', undefined, ST)).json?.data ?? [];
const both = await call(
  'PUT',
  '/printing/consumption-rules',
  { rules: [{ option_id: A4, variant_id: PAPER, basis: 'per_sheet', qty: 1, yield_pages: 2000 }] },
  ST,
);
chk(
  'a rule with a quantity AND a yield is refused',
  both.status === 422 && keyOf(both) === 'print_consumption_rule_invalid',
  String(keyOf(both)),
);
const ghost = await call(
  'PUT',
  '/printing/consumption-rules',
  { rules: [{ option_id: A4, variant_id: 99_999_999, basis: 'per_sheet', qty: 1 }] },
  ST,
);
chk(
  'an unknown material is refused',
  ghost.status === 422 && keyOf(ghost) === 'print_consumption_material_unknown',
  String(keyOf(ghost)),
);
const set = await call(
  'PUT',
  '/printing/consumption-rules',
  {
    rules: [
      { option_id: A4, variant_id: PAPER, basis: 'per_sheet', qty: 1 },
      { option_id: BW, variant_id: TONER, basis: 'per_printed_page', yield_pages: 2000 },
      { option_id: SPIRAL, variant_id: WIRE, basis: 'per_copy', qty: 1 },
    ],
  },
  ST,
);
chk(
  'the recipe is saved with the material names',
  set.status === 200 &&
    set.json?.data?.length === 3 &&
    typeof set.json?.data?.[0]?.name_ar === 'string',
);
const paperSku = set.json?.data?.find((r: { variant_id: number }) => r.variant_id === PAPER)?.sku as string;
const found = await call('GET', `/printing/materials?search=${encodeURIComponent(paperSku)}`, undefined, ST);
chk(
  'the material picker finds an item by its code, with its base unit',
  found.json?.data?.some(
    (m: { variant_id: number; unit_name_ar: string }) => m.variant_id === PAPER && typeof m.unit_name_ar === 'string',
  ),
);
const customerMaterials = await call('GET', '/printing/materials?search=a', undefined, CT);
chk('…and refuses a customer', customerMaterials.status === 401 || customerMaterials.status === 403, String(customerMaterials.status));

async function startedJob(pages: number, copies: number, sides: number): Promise<number> {
  const j = (
    await call(
      'POST',
      '/print-jobs',
      {
        branch_id: branchId,
        copies,
        paper_size_id: A4,
        color_mode_id: BW,
        sides_id: sides,
        binding_id: SPIRAL,
        cover_id: NO_COVER,
      },
      CT,
    )
  ).json?.data;
  await call('POST', `/print-jobs/${j.id}/links`, { url: 'https://example.com/thesis.pdf' }, CT);
  await call('POST', `/print-jobs/${j.id}/submit`, undefined, CT);
  await call('POST', `/printing/jobs/${j.id}/quote`, { pages }, ST);
  await call('POST', `/printing/jobs/${j.id}/defer`, { reason: 'تجربة الاستهلاك' }, ST);
  return j.id;
}

// ── a 50-page double-sided job, 2 copies: 100 printed pages, 50 sheets ──
const paper0 = await balance(PAPER);
const toner0 = await balance(TONER);
const wire0 = await balance(WIRE);
const jobId = await startedJob(50, 2, DOUBLE);
const started = await call(
  'POST',
  `/printing/jobs/${jobId}/status`,
  { status: 'in_production' },
  ST,
);
chk(
  'production starts',
  started.json?.data?.status === 'in_production',
  String(keyOf(started) ?? started.status),
);
chk(
  'paper leaves by sheets (50), not printed pages (100)',
  round((await balance(PAPER)) - paper0) === -50,
  `${paper0} → ${await balance(PAPER)}`,
);
chk('binding leaves by copy (2)', round((await balance(WIRE)) - wire0) === -2);
chk(
  'ink leaves by yield: 100 pages of a 2000-page cartridge = 0.05',
  round((await balance(TONER)) - toner0) === -0.05,
  `${toner0} → ${await balance(TONER)}`,
);
const movements = await pool.query<{ n: string }>(
  "SELECT count(*) AS n FROM stock_movements WHERE type = 'production_consume' AND source_doc_type = 'print_job' AND source_doc_id = $1",
  [jobId],
);
chk(
  'the movements point back at the job',
  Number(movements.rows[0]?.n) === 3,
  String(movements.rows[0]?.n),
);

const materials = started.json?.data?.materials;
chk(
  'the job carries its materials and cost (for those who set prices)',
  materials !== null && materials?.lines?.length === 3 && typeof materials?.cost_syp === 'number',
);
chk(
  'profit = price − materials',
  round(materials?.profit_syp, 2) ===
    round(started.json?.data?.quoted_total_syp - materials?.cost_syp, 2),
  `${started.json?.data?.quoted_total_syp} − ${materials?.cost_syp} = ${materials?.profit_syp}`,
);
const mine = (await call('GET', `/print-jobs/${jobId}`, undefined, CT)).json?.data;
chk('the customer never sees cost or profit', mine && !('materials' in mine));

// ── ink: a baseline, then a real reconciliation ──
let list =
  (await call('GET', `/printing/consumables?branch_id=${branchId}`, undefined, ST)).json?.data ??
  [];
let toner = list.find((c: { variant_id: number }) => c.variant_id === TONER);
chk(
  'the toner is listed as yield-tracked; paper is not',
  !!toner && !list.some((c: { variant_id: number }) => c.variant_id === PAPER),
);
const notTracked = await call(
  'POST',
  `/printing/consumables/${PAPER}/install`,
  { branch_id: branchId },
  ST,
);
chk(
  '«new cartridge» on paper is refused',
  notTracked.status === 422 && keyOf(notTracked) === 'print_consumable_not_tracked',
  String(keyOf(notTracked)),
);

const first = (
  await call('POST', `/printing/consumables/${TONER}/install`, { branch_id: branchId }, ST)
).json?.data;
chk(
  'the first install is a baseline — nothing reconciled',
  first?.baseline === true && first?.correction === 0,
  JSON.stringify(first),
);

// A single-sided page: 1/2000 cartridge — below the ledger's 0.001 step.
const tonerBeforeTiny = await balance(TONER);
const tiny = await startedJob(1, 1, SINGLE);
await call('POST', `/printing/jobs/${tiny}/status`, { status: 'in_production' }, ST);
chk(
  'one page of ink waits in the meter instead of rounding to zero',
  round((await balance(TONER)) - tonerBeforeTiny) === 0,
);
list =
  (await call('GET', `/printing/consumables?branch_id=${branchId}`, undefined, ST)).json?.data ??
  [];
toner = list.find((c: { variant_id: number }) => c.variant_id === TONER);
chk(
  '…and is counted since the install',
  toner?.pages_since_install === 1 && toner?.estimated_since_install === 0.0005,
  JSON.stringify(toner),
);
chk(
  'what installing now would reconcile is said before confirming',
  toner?.correction_if_installed_now === 1,
);

const tonerBeforeInstall = await balance(TONER);
const second = (
  await call('POST', `/printing/consumables/${TONER}/install`, { branch_id: branchId }, ST)
).json?.data;
chk(
  'a real install consumes what the estimate missed',
  second?.baseline === false && second?.correction === 1,
  JSON.stringify(second),
);
chk('…and the shelf follows reality', round((await balance(TONER)) - tonerBeforeInstall) === -1);
chk('…and the real numbers suggest a yield', second?.suggested_yield_pages === 1);

// restore the recipe the dev database had
await call(
  'PUT',
  '/printing/consumption-rules',
  {
    rules: before.map(
      (r: {
        option_id: number;
        variant_id: number;
        basis: string;
        qty: number | null;
        yield_pages: number | null;
      }) => ({
        option_id: r.option_id,
        variant_id: r.variant_id,
        basis: r.basis,
        qty: r.qty,
        yield_pages: r.yield_pages,
      }),
    ),
  },
  ST,
);

server.close();
await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
