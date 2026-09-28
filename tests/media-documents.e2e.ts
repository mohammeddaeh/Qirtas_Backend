/**
 * End-to-end: customer documents on a **real store** — reserve → direct PUT →
 * complete → signed download → sweep, against both drivers.
 *
 *   docker compose up -d postgres s3 && npm run storage:setup   (with the S3_* values below)
 *   npx tsx tests/media-documents.e2e.ts
 *
 * The S3 half needs the SeaweedFS container from docker-compose.yml; the local
 * half boots the app on an ephemeral port and uploads through
 * `PUT /files/uploads/:token`. Every acceptance is paired with the refusal next
 * to it — "the upload worked" passes for a store that accepts any body at all.
 */
process.env['STORAGE_SIGNING_KEY'] ??= 'e2e-signing-key-'.padEnd(40, 'x');
process.env['MAIL_TRANSPORT'] ??= 'log';

const S3 = {
  bucket: process.env['S3_BUCKET'] ?? 'qirtas',
  region: 'us-east-1',
  endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:8333',
  accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'qirtas',
  secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'qirtas-dev-secret',
  forcePathStyle: true,
};

const { S3Driver } = await import('../src/core/media/adapters/s3.driver.js');
const { LocalDiskDriver } = await import('../src/core/media/adapters/local-disk.driver.js');
const { configureMedia, urlSigner } = await import('../src/core/media/composition.js');
const documents = await import('../src/core/media/documents.service.js');
const { sweepExpiredDocuments } = await import('../src/core/media/document-sweeper.js');
const repo = await import('../src/core/media/repositories/media-assets.repository.js');
const { buildApp } = await import('../src/app.js');
const { storageDriver } = await import('../src/core/media/ports/storage-driver.js');
const { pool } = await import('../src/core/db/client.js');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
type Row = Awaited<ReturnType<typeof documents.findDocument>>;

let pass = 0;
let fail = 0;
const chk = (name: string, ok: boolean, extra = ''): void => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  [${extra}]` : ''}`);
};

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2046)]);
const policy = {
  maxBytes: 50 * 1024 * 1024,
  allowed: ['pdf', 'docx', 'jpg', 'png', 'txt'] as const,
};

async function put(url: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  const r = await fetch(url, { method: 'PUT', headers, body });
  await r.arrayBuffer();
  return r.status;
}

async function journey(label: string, base: string): Promise<void> {
  const abs = (u: string): string => (u.startsWith('http') ? u : base + u);

  // ── reserve refusals: before a byte leaves the phone ──
  let refused = '';
  try {
    await documents.reserveDocument({
      filename: 'big.pdf',
      bytes: policy.maxBytes + 1,
      uploader: { userId: 1 },
      policy,
    });
  } catch (e) {
    refused = (e as { messageKey?: string }).messageKey ?? String(e);
  }
  chk(`${label}: reserve refuses a file over the limit`, refused === 'document_too_large', refused);
  refused = '';
  try {
    await documents.reserveDocument({
      filename: 'setup.exe',
      bytes: 10,
      uploader: { userId: 1 },
      policy,
    });
  } catch (e) {
    refused = (e as { messageKey?: string }).messageKey ?? String(e);
  }
  chk(
    `${label}: reserve refuses a name that is not an accepted type`,
    refused === 'document_type_not_allowed',
    refused,
  );

  // ── happy path ──
  const { asset, upload } = await documents.reserveDocument({
    filename: 'بحث التخرج.pdf',
    bytes: PDF.length,
    uploader: { userId: 1 },
    policy,
  });
  chk(
    `${label}: reserved row is pending with a deadline`,
    asset.status === 'pending' && asset.expires_at !== null,
  );

  let early = '';
  try {
    await documents.completeDocument(asset, policy);
  } catch (e) {
    early = (e as { messageKey?: string }).messageKey ?? String(e);
  }
  chk(
    `${label}: complete before the upload answers document_not_uploaded`,
    early === 'document_not_uploaded',
    early,
  );

  const longer = await put(
    abs(upload.url),
    upload.headers,
    Buffer.concat([PDF, Buffer.alloc(100)]),
  );
  chk(`${label}: the store refuses a body larger than declared`, longer >= 400, String(longer));
  const wrongType = await put(abs(upload.url), { 'Content-Type': 'application/pdf' }, PDF);
  chk(`${label}: the store refuses a different Content-Type`, wrongType >= 400, String(wrongType));
  const ok = await put(abs(upload.url), upload.headers, PDF);
  chk(`${label}: the exact body is accepted`, ok >= 200 && ok < 300, String(ok));

  const ready = await documents.completeDocument(asset, policy);
  chk(
    `${label}: complete → ready, type from the bytes`,
    ready.status === 'ready' && ready.document_type === 'pdf',
  );
  chk(
    `${label}: ready carries the stored size and a default deadline`,
    ready.original_bytes === PDF.length && ready.expires_at !== null,
  );
  const again = await documents.completeDocument(ready, policy);
  chk(`${label}: completing twice is not an error`, again.status === 'ready');

  const link = await documents.documentDownloadUrl(ready);
  const got = await fetch(abs(link));
  const bytes = Buffer.from(await got.arrayBuffer());
  chk(
    `${label}: the download link serves the same bytes`,
    got.status === 200 && bytes.equals(PDF),
    String(got.status),
  );
  const disposition = got.headers.get('content-disposition') ?? '';
  chk(
    `${label}: offered under its Arabic name as an attachment`,
    disposition.startsWith('attachment') &&
      disposition.includes(encodeURIComponent('بحث التخرج.pdf')),
    disposition,
  );
  const tampered = new URL(abs(link));
  const sig = tampered.searchParams.has('signature') ? 'signature' : 'X-Amz-Signature';
  tampered.searchParams.set(sig, '0'.repeat(64));
  const bad = await fetch(tampered);
  await bad.arrayBuffer();
  chk(`${label}: a tampered link is refused`, bad.status === 403, String(bad.status));

  // ── an executable named .pdf ──
  const evil = await documents.reserveDocument({
    filename: 'invoice.pdf',
    bytes: EXE.length,
    uploader: { userId: 1 },
    policy,
  });
  await put(abs(evil.upload.url), evil.upload.headers, EXE);
  const rejected = await documents.completeDocument(evil.asset, policy);
  chk(`${label}: an executable named invoice.pdf is rejected`, rejected.status === 'rejected');
  // A rejected document has no link to issue; ask the store directly.
  chk(
    `${label}: …and its bytes are deleted at once`,
    (await storageDriver().size('private', evil.asset.key_base)) === null,
  );

  // ── sweeper ──
  await repo.setExpiry([ready.id], new Date(Date.now() - 1000));
  const abandoned = await documents.reserveDocument({
    filename: 'x.pdf',
    bytes: 10,
    uploader: { userId: 1 },
    policy,
  });
  await repo.setExpiry([abandoned.asset.id], new Date(Date.now() - 1000));
  const keep = await documents.reserveDocument({
    filename: 'y.pdf',
    bytes: 10,
    uploader: { userId: 1 },
    policy,
  });

  // Another machine holds the lock: this round must skip.
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('core.media.document_sweep'))`);
  const blocked = await sweepExpiredDocuments();
  await client.query('COMMIT');
  client.release();
  chk(
    `${label}: a sweep while another machine holds the lock skips`,
    blocked.skipped && blocked.deleted === 0,
  );

  const swept = await sweepExpiredDocuments();
  chk(
    `${label}: the next sweep deletes what expired`,
    !swept.skipped && swept.deleted >= 2,
    JSON.stringify(swept),
  );
  const afterReady = (await documents.findDocument(ready.id)) as NonNullable<Row>;
  const afterAbandoned = (await documents.findDocument(abandoned.asset.id)) as NonNullable<Row>;
  const afterKeep = (await documents.findDocument(keep.asset.id)) as NonNullable<Row>;
  chk(
    `${label}: the row stays as history with its reason`,
    afterReady.status === 'deleted' && afterReady.delete_reason === 'retention_expired',
  );
  chk(
    `${label}: an abandoned reservation is named as such`,
    afterAbandoned.delete_reason === 'upload_abandoned',
  );
  chk(
    `${label}: the object itself is gone`,
    (await storageDriver().size('private', ready.key_base)) === null,
  );
  chk(`${label}: a document not yet due is untouched`, afterKeep.status === 'pending');
  await repo.setExpiry([keep.asset.id], new Date(Date.now() - 1000));
  await sweepExpiredDocuments();
}

// ── S3 (SeaweedFS) ──
const s3 = new S3Driver(S3);
configureMedia(s3);
await journey('s3', '');

// ── local disk, through the real HTTP upload route ──
const root = await mkdtemp(join(tmpdir(), 'qirtas-e2e-'));
const app = buildApp();
configureMedia(new LocalDiskDriver(root, urlSigner()));
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
await journey('local', `http://localhost:${port}`);

// With S3 configured, the local upload route must not write to this machine.
configureMedia(s3);
const stray = await fetch(`http://localhost:${port}/api/v1/files/uploads/abc.def`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: Buffer.from('x'),
});
chk(
  's3 configured: the local upload route answers 404',
  stray.status === 404,
  String(stray.status),
);

server.close();
await rm(root, { recursive: true, force: true });

await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
