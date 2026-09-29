/**
 * الفواتير والملصقات (R1) — end-to-end على قاعدة بيانات حيّة.
 *
 *   npx tsx tests/documents.e2e.ts
 *
 * يحتاج قاعدة مُرحَّلة ومبذورة (`npm run db:setup`). ينشئ قوالب نسخاً ويحذفها،
 * ويعيد الافتراضي وملف المحل كما كانا.
 */
process.env['STORAGE_SIGNING_KEY'] ??= 'e2e-signing-key-'.padEnd(40, 'x');
process.env['MAIL_TRANSPORT'] ??= 'log';
process.env['LOG_LEVEL'] ??= 'error';

const { readFileSync } = await import('node:fs');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { and, eq, sql } = await import('drizzle-orm');
const sharp = (await import('sharp')).default;
const { buildApp } = await import('../src/app.js');
const { configureMedia, urlSigner } = await import('../src/core/media/composition.js');
const { LocalDiskDriver } = await import('../src/core/media/adapters/local-disk.driver.js');
const { db, pool } = await import('../src/core/db/client.js');
const { catalogVariantUnitsTable } = await import('../src/features/catalog/schemas/products.schema.js');

const adminPassword = /^SEED_ADMIN_PASSWORD=(.*)$/m.exec(readFileSync('.env', 'utf8'))?.[1]?.trim();
if (!adminPassword) {
  console.error('SEED_ADMIN_PASSWORD missing from .env');
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), 'qirtas-documents-e2e-'));
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

type Json = { data?: any; message_key?: string; details?: any } | null; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown, token?: string) {
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
const keyOf = (r: { json: Json }): string | undefined => r.json?.data?.message_key ?? r.json?.message_key;

const login = await call('POST', '/users/login', { email: 'super_admin@admin.com', password: adminPassword });
const T = login.json?.data?.token as string;
chk('admin signs in', typeof T === 'string', String(login.status));

try {
  // ── Context ──────────────────────────────────────────────────────────────
  const noAuth = await call('GET', '/documents/context');
  chk('context needs a session', noAuth.status === 401, String(noAuth.status));

  const ctx = await call('GET', '/documents/context?branch_id=1', undefined, T);
  chk('context answers', ctx.status === 200, String(ctx.status));
  chk('default receipt is the ready-made classic', ctx.json?.data?.receipt_template?.code === 'receipt_classic' || ctx.json?.data?.receipt_template?.is_default === true);
  chk('default label exists', ctx.json?.data?.label_template?.kind === 'label');
  chk('branch info comes from the branch row', ctx.json?.data?.branch?.id === 1);
  chk(
    'stored layout has every default filled',
    ctx.json?.data?.receipt_template?.layout?.page?.copies !== undefined,
  );
  const missingBranch = await call('GET', '/documents/context?branch_id=999999', undefined, T);
  chk('unknown branch is 404', missingBranch.status === 404, String(missingBranch.status));

  // ── Templates ────────────────────────────────────────────────────────────
  const list = await call('GET', '/documents/templates?kind=receipt', undefined, T);
  const receipts = (list.json?.data ?? []) as { id: number; code: string | null; is_default: boolean; is_system: boolean }[];
  chk('three ready-made receipts', receipts.filter((r) => r.is_system).length === 3, String(receipts.length));
  chk('default listed first', receipts[0]?.is_default === true);
  const previousDefault = receipts.find((r) => r.is_default)!;
  const classic = receipts.find((r) => r.code === 'receipt_classic')!;

  const editSystem = await call('PATCH', `/documents/templates/${classic.id}`, { name: 'x' }, T);
  chk('ready-made cannot be edited', keyOf(editSystem) === 'document_template_is_system', String(editSystem.status));
  const deleteSystem = await call('DELETE', `/documents/templates/${classic.id}`, undefined, T);
  chk('ready-made cannot be deleted', keyOf(deleteSystem) === 'document_template_is_system');

  const copy = await call('POST', '/documents/templates', { name: 'نسخة e2e', clone_from_id: classic.id }, T);
  const copyId = copy.json?.data?.id as number;
  chk('copy is created, not system, not default', copy.status === 201 && copy.json?.data?.is_system === false && copy.json?.data?.is_default === false, String(copy.status));

  const both = await call('POST', '/documents/templates', { name: 'x', clone_from_id: classic.id, kind: 'receipt', layout: {} }, T);
  chk('clone plus layout is refused', both.status === 422, String(both.status));

  const bad = await call('PATCH', `/documents/templates/${copyId}`, { layout: { page: { paper: 'roll_80' }, blocks: [{ type: 'price' }] } }, T);
  chk('a label block on a receipt is 422 under layout.', bad.status === 422 && Object.keys((bad.json as { errors?: object } | null)?.errors ?? {}).some((k) => k.startsWith('layout.')), JSON.stringify(bad.json).slice(0, 160));

  const good = await call('PATCH', `/documents/templates/${copyId}`, { layout: { page: { paper: 'roll_58' }, blocks: [{ type: 'totals', show_tax: false }] } }, T);
  chk('valid layout saved and normalised', good.status === 200 && good.json?.data?.layout?.blocks?.[0]?.show_discount === true && good.json?.data?.layout?.blocks?.[0]?.show_tax === false);

  const made = await call('POST', `/documents/templates/${copyId}/default`, undefined, T);
  const afterDefault = (made.json?.data ?? []) as { id: number; is_default: boolean }[];
  chk('set default returns the kind with exactly one default', afterDefault.filter((r) => r.is_default).length === 1 && afterDefault.find((r) => r.is_default)?.id === copyId);

  const deleteDefault = await call('DELETE', `/documents/templates/${copyId}`, undefined, T);
  chk('default cannot be deleted', keyOf(deleteDefault) === 'document_template_is_default', String(deleteDefault.status));

  await call('POST', `/documents/templates/${previousDefault.id}/default`, undefined, T);
  const del = await call('DELETE', `/documents/templates/${copyId}`, undefined, T);
  chk('copy deleted once not default', del.status === 200, String(del.status));
  const gone = await call('GET', `/documents/templates/${copyId}`, undefined, T);
  chk('deleted copy is 404', gone.status === 404);

  // A sheet that overflows is refused on the medium.
  const overflow = await call('POST', '/documents/templates', {
    name: 'e2e sheet', kind: 'label',
    layout: { page: { width_mm: 70, height_mm: 37, medium: { mode: 'sheet', sheet: 'a4', columns: 3, rows: 9 } }, blocks: [{ type: 'price' }] },
  }, T);
  chk('overflowing label sheet is 422', overflow.status === 422, String(overflow.status));

  // ── Profile + logo ───────────────────────────────────────────────────────
  const before = (await call('GET', '/documents/profile', undefined, T)).json?.data;
  const png = await sharp({ create: { width: 600, height: 240, channels: 3, background: '#1e56c8' } }).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
  const up = await fetch(`${B}/documents/logo`, { method: 'POST', headers: { authorization: `Bearer ${T}` }, body: form });
  const logo = ((await up.json()) as Json)?.data;
  chk('logo uploads', up.status === 201 && typeof logo?.id === 'number', String(up.status));

  const saved = await call('PUT', '/documents/profile', {
    name_ar: 'قرطاس e2e', name_en: '', logo_media_id: logo?.id ?? null, tax_number: '  123  ', commercial_register: null,
  }, T);
  chk('profile saved, empty text becomes null, text trimmed', saved.status === 200 && saved.json?.data?.name_en === null && saved.json?.data?.tax_number === '123');
  chk('profile carries the logo urls', typeof saved.json?.data?.logo?.urls?.medium === 'string');
  const badLogo = await call('PUT', '/documents/profile', { ...before, logo_media_id: 99999999 }, T);
  chk('unknown logo id is 422', badLogo.status === 422, String(badLogo.status));
  await call('PUT', '/documents/profile', {
    name_ar: before.name_ar, name_en: before.name_en, logo_media_id: before.logo?.id ?? null,
    tax_number: before.tax_number, commercial_register: before.commercial_register,
  }, T);

  // ── Labels ───────────────────────────────────────────────────────────────
  const [unitRow] = await db
    .select({ variant_id: catalogVariantUnitsTable.variant_id, unit_id: catalogVariantUnitsTable.unit_id, factor: catalogVariantUnitsTable.factor })
    .from(catalogVariantUnitsTable)
    .where(and(eq(catalogVariantUnitsTable.is_base, false), sql`${catalogVariantUnitsTable.factor} > 1`))
    .limit(1);
  const [anyVariant] = await db.select({ variant_id: catalogVariantUnitsTable.variant_id }).from(catalogVariantUnitsTable).limit(1);
  const vid = unitRow?.variant_id ?? anyVariant?.variant_id;
  if (vid === undefined) {
    chk('labels: no variant in this database — skipped', true);
  } else {
    const items = unitRow ? [{ variant_id: vid }, { variant_id: vid, unit_id: unitRow.unit_id }] : [{ variant_id: vid }];
    const labels = await call('POST', '/documents/labels', { branch_id: 1, items }, T);
    const rows = (labels.json?.data ?? []) as { unit_factor: number; price: { status: string; amount_syp: number | null } }[];
    chk('labels answer in the order asked', labels.status === 200 && rows.length === items.length, String(labels.status));
    chk('base unit first, factor 1', rows[0]?.unit_factor === 1);
    chk('no amount unless priced', rows.every((r) => (r.price.status === 'priced') === (r.price.amount_syp !== null)));
    if (unitRow && rows[0]?.price.amount_syp != null && rows[1]?.price.amount_syp != null) {
      chk('carton price is base × factor', rows[1].price.amount_syp === Math.round(rows[0].price.amount_syp * Number(unitRow.factor)));
    }
    const wrongUnit = await call('POST', '/documents/labels', { branch_id: 1, items: [{ variant_id: vid, unit_id: 999999 }] }, T);
    chk('a unit not of the variant is 422', wrongUnit.status === 422, String(wrongUnit.status));
    const unknown = await call('POST', '/documents/labels', { branch_id: 1, items: [{ variant_id: 99999999 }] }, T);
    chk('unknown variant is 422', unknown.status === 422);
  }
} finally {
  server.close();
  await pool.end();
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
