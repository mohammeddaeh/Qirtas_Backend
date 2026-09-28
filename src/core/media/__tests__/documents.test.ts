import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskDriver, UploadSizeError } from '../adapters/local-disk.driver.js';
import { UrlSigner } from '../signed-url.js';
import { contentDisposition } from '../content-disposition.js';
import { declaredType, sniff, DOCUMENT_TYPES, type DocumentType } from '../document-types.js';

/**
 * Every failure here is silent: a sniffer that trusts the name prints an
 * executable on the shop PC, a token that accepts a longer body lets one
 * customer fill the disk, a link whose name is not signed can be re-labelled
 * `invoice.exe` — and each one answers 200. So each rule is pinned WITH its
 * opposite: accepting a PDF proves nothing on its own (a function returning the
 * declared type passes it).
 */

const ALL: readonly DocumentType[] = DOCUMENT_TYPES;
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(510)]);
const CFB = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(4088),
]);

describe('declaredType — the name is a hint, read case-insensitively', () => {
  it.each([
    ['Thesis.PDF', 'pdf'],
    ['photo.jpeg', 'jpg'],
    ['IMG_0001.HEIF', 'heic'],
    ['بحث التخرج.docx', 'docx'],
    ['notes.txt', 'txt'],
  ])('%s → %s', (name, type) => {
    expect(declaredType(name)).toBe(type);
  });

  it.each(['setup.exe', 'archive.zip', 'no-extension', 'trailing.', 'script.pdf.js'])(
    '%s → null (not an accepted type)',
    (name) => {
      expect(declaredType(name)).toBeNull();
    },
  );
});

describe('sniff — the bytes decide', () => {
  it('accepts real PDF, PNG and JPEG bytes', async () => {
    expect(await sniff(PDF, 'pdf', ALL)).toBe('pdf');
    expect(await sniff(PNG, 'png', ALL)).toBe('png');
    expect(await sniff(JPG, 'jpg', ALL)).toBe('jpg');
  });

  it('reports what the bytes are, not what the name said', async () => {
    // A PNG named .pdf is still accepted — as a PNG. The reader gets the right app.
    expect(await sniff(PNG, 'pdf', ALL)).toBe('png');
  });

  it('refuses an executable named invoice.pdf', async () => {
    expect(await sniff(EXE, 'pdf', ALL)).toBeNull();
  });

  it('accepts a real Office file (xlsx is a zip; the entries identify it)', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('a').addRow([1]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await sniff(bytes, 'xlsx', ALL)).toBe('xlsx');
  });

  it('accepts a legacy Office container only under a legacy Office name', async () => {
    expect(await sniff(CFB, 'doc', ALL)).toBe('doc');
    expect(await sniff(CFB, 'xls', ALL)).toBe('xls');
    // The same container is an .msi installer — never accepted under another name.
    expect(await sniff(CFB, 'pdf', ALL)).toBeNull();
    expect(await sniff(CFB, null, ALL)).toBeNull();
  });

  it('accepts UTF-8 text declared .txt, Arabic included', async () => {
    expect(await sniff(Buffer.from('ملاحظات الطباعة\nصفحتان', 'utf8'), 'txt', ALL)).toBe('txt');
  });

  it('refuses text that was not declared .txt, and binary declared .txt', async () => {
    expect(await sniff(Buffer.from('hello'), 'pdf', ALL)).toBeNull();
    expect(await sniff(Buffer.from([0x68, 0x00, 0x69]), 'txt', ALL)).toBeNull();
    expect(await sniff(Buffer.from([0xc3, 0x28, 0x41, 0x42, 0x43, 0x44]), 'txt', ALL)).toBeNull();
    expect(await sniff(Buffer.alloc(0), 'txt', ALL)).toBeNull();
  });

  it('accepts text whose head was cut mid-character', async () => {
    const arabic = Buffer.from('طباعة', 'utf8');
    expect(await sniff(arabic.subarray(0, arabic.length - 1), 'txt', ALL)).toBe('txt');
  });

  it('refuses a real type the caller did not allow', async () => {
    expect(await sniff(PNG, 'png', ['pdf'])).toBeNull();
    expect(await sniff(PDF, 'pdf', ['pdf'])).toBe('pdf');
  });
});

describe('upload tokens', () => {
  const signer = new UrlSigner('x'.repeat(32));
  const now = new Date('2026-09-28T10:00:00Z');
  const grant = {
    zone: 'private',
    key: 'doc/2026/09/abc.bin',
    bytes: 1234,
    contentType: 'application/octet-stream',
  };

  it('round-trips what it granted before expiry', () => {
    const { token } = signer.signUpload(grant, 900, now);
    expect(signer.verifyUpload(token, now)).toMatchObject(grant);
  });

  it('refuses the same token after expiry', () => {
    const { token } = signer.signUpload(grant, 900, now);
    expect(signer.verifyUpload(token, new Date(now.getTime() + 901_000))).toBeNull();
  });

  it('refuses a token whose payload was edited to a larger size', () => {
    const { token } = signer.signUpload(grant, 900, now);
    const [, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ z: 'private', k: grant.key, n: 999_999_999, t: grant.contentType, e: 9e9 }),
    ).toString('base64url');
    expect(signer.verifyUpload(`${forged}.${mac}`, now)).toBeNull();
  });

  it('refuses a token from another secret, and garbage without throwing', () => {
    const { token } = new UrlSigner('y'.repeat(32)).signUpload(grant, 900, now);
    expect(signer.verifyUpload(token, now)).toBeNull();
    expect(signer.verifyUpload('', now)).toBeNull();
    expect(signer.verifyUpload('abc', now)).toBeNull();
    expect(signer.verifyUpload('.deadbeef', now)).toBeNull();
  });

  it('is not interchangeable with a download signature', () => {
    const { expires, signature } = signer.sign('private', grant.key, 900, now);
    expect(signer.verifyUpload(`${signature}.${signature}`, now)).toBeNull();
    const { token } = signer.signUpload(grant, 900, now);
    expect(signer.verify('private', grant.key, expires, token.split('.')[1]!, now)).toBe(false);
  });
});

describe('download links carry a signed name', () => {
  const signer = new UrlSigner('x'.repeat(32));
  const now = new Date('2026-09-28T10:00:00Z');
  const key = 'doc/2026/09/abc.bin';

  it('verifies with the name it was signed for', () => {
    const { expires, signature } = signer.sign('private', key, 600, now, 'بحث.pdf');
    expect(signer.verify('private', key, expires, signature, now, 'بحث.pdf')).toBe(true);
  });

  it('refuses the same link re-labelled, or with its name dropped', () => {
    const { expires, signature } = signer.sign('private', key, 600, now, 'بحث.pdf');
    expect(signer.verify('private', key, expires, signature, now, 'invoice.exe')).toBe(false);
    expect(signer.verify('private', key, expires, signature, now)).toBe(false);
  });

  it('refuses a name added to a link signed without one', () => {
    const { expires, signature } = signer.sign('private', key, 600, now);
    expect(signer.verify('private', key, expires, signature, now, 'x.pdf')).toBe(false);
  });
});

describe('contentDisposition', () => {
  it('saves under the original Arabic name, with an ASCII fallback', () => {
    const header = contentDisposition('بحث "التخرج".pdf');
    expect(header.startsWith('attachment; filename="')).toBe(true);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('بحث "التخرج".pdf')}`);
    // The fallback cannot break out of its quotes.
    expect(header.split('filename*')[0]).not.toMatch(/filename=".*".*"/);
  });

  it('is a bare attachment without a name', () => {
    expect(contentDisposition(null)).toBe('attachment');
  });
});

describe('LocalDiskDriver — direct uploads', () => {
  let root: string;
  let driver: LocalDiskDriver;
  const signer = new UrlSigner('x'.repeat(32));
  const key = 'doc/2026/09/upload.bin';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'qirtas-docs-'));
    driver = new LocalDiskDriver(root, signer);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('streams exactly the granted size to disk', async () => {
    await driver.putStream(
      'private',
      key,
      Readable.from([Buffer.from('12345'), Buffer.from('678')]),
      8,
    );
    expect(await driver.size('private', key)).toBe(8);
    expect(await readFile(join(root, 'private', key), 'utf8')).toBe('12345678');
  });

  it('refuses a longer body and leaves nothing under the key', async () => {
    const k = 'doc/2026/09/long.bin';
    await expect(
      driver.putStream('private', k, Readable.from([Buffer.alloc(9)]), 8),
    ).rejects.toBeInstanceOf(UploadSizeError);
    expect(await driver.exists('private', k)).toBe(false);
  });

  it('refuses a shorter body too (the declared size is the contract)', async () => {
    const k = 'doc/2026/09/short.bin';
    await expect(
      driver.putStream('private', k, Readable.from([Buffer.alloc(7)]), 8),
    ).rejects.toMatchObject({
      reason: 'too_small',
    });
    expect(await driver.exists('private', k)).toBe(false);
  });

  it('reads the head of a file, and less of a smaller one', async () => {
    expect((await driver.readHead('private', key, 3))?.toString()).toBe('123');
    expect((await driver.readHead('private', key, 100))?.toString()).toBe('12345678');
  });

  it('answers a missing file with null for size and head', async () => {
    expect(await driver.size('private', 'doc/2026/09/missing.bin')).toBeNull();
    expect(await driver.readHead('private', 'doc/2026/09/missing.bin', 10)).toBeNull();
  });

  it('issues an upload link its own signer accepts, for the same key and size', async () => {
    const target = await driver.uploadTarget('private', key, {
      bytes: 42,
      contentType: 'application/octet-stream',
      ttlSeconds: 900,
    });
    expect(target.method).toBe('PUT');
    expect(target.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    const token = target.url.split('/uploads/')[1]!;
    expect(signer.verifyUpload(token)).toMatchObject({ key, bytes: 42, zone: 'private' });
  });

  it('issues a download link whose name is part of the signature', async () => {
    const url = await driver.downloadUrl(key, {
      filename: 'بحث.pdf',
      contentType: 'application/pdf',
      ttlSeconds: 600,
    });
    const query = new URL(url, 'http://x').searchParams;
    expect(query.get('name')).toBe('بحث.pdf');
    const expires = Number(query.get('expires'));
    expect(
      signer.verify('private', key, expires, query.get('signature')!, new Date(), 'بحث.pdf'),
    ).toBe(true);
    expect(
      signer.verify('private', key, expires, query.get('signature')!, new Date(), 'x.exe'),
    ).toBe(false);
  });

  it('refuses to issue links for a key outside the grammar', async () => {
    await expect(
      driver.uploadTarget('private', '../x.bin', { bytes: 1, contentType: 'x', ttlSeconds: 1 }),
    ).rejects.toThrow();
  });
});
