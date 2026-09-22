import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskDriver } from '../adapters/local-disk.driver.js';
import { isValidStorageKey, newStorageKeyBase, variantKey } from '../storage-keys.js';
import { UrlSigner } from '../signed-url.js';

/**
 * Every failure here is silent in production: a traversal bug serves another
 * customer's ID copy with a 200, a signer that accepts too much hands out
 * permanent links, and neither shows up as an error anywhere. So each rule is
 * pinned WITH its opposite — accepting a good key proves nothing on its own
 * (a function returning `true` passes it).
 */

describe('storage keys', () => {
  it('accepts the keys the server generates', () => {
    const key = variantKey(newStorageKeyBase('img', new Date('2026-09-22')), 'thumb', 'webp');
    expect(key).toMatch(/^img\/2026\/09\/[0-9a-f-]{36}_thumb\.webp$/);
    expect(isValidStorageKey(key)).toBe(true);
  });

  it.each([
    '../secret.webp',
    'img/../../etc/passwd.txt',
    '/img/a.webp',
    'img\\a.webp',
    'C:/img/a.webp',
    'img//a.webp',
    'IMG/A.webp',
    'img/a',
    '',
  ])('rejects %j', (key) => {
    expect(isValidStorageKey(key)).toBe(false);
  });

  it('never repeats a base, so public files can be cached as immutable', () => {
    expect(newStorageKeyBase('img')).not.toBe(newStorageKeyBase('img'));
  });
});

describe('LocalDiskDriver', () => {
  let root: string;
  let driver: LocalDiskDriver;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'qirtas-storage-'));
    driver = new LocalDiskDriver(root);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('round-trips bytes and reports the size', async () => {
    await driver.put('public', 'img/2026/09/abc_thumb.webp', Buffer.from('hello'));
    const object = await driver.open('public', 'img/2026/09/abc_thumb.webp');
    expect(object?.size).toBe(5);
    expect(await text(object!.stream)).toBe('hello');
  });

  it('keeps the zones apart — a public key does not read a private file', async () => {
    await driver.put('private', 'doc/2026/09/id-copy_original.pdf', Buffer.from('secret'));
    expect(await driver.open('public', 'doc/2026/09/id-copy_original.pdf')).toBeNull();
    expect(await driver.exists('private', 'doc/2026/09/id-copy_original.pdf')).toBe(true);
  });

  it('answers a missing file with null, not an error', async () => {
    expect(await driver.open('public', 'img/2026/09/missing_thumb.webp')).toBeNull();
  });

  it('refuses a key that would escape the root', async () => {
    await expect(driver.put('public', '../escape.webp', Buffer.from('x'))).rejects.toThrow();
    await expect(driver.open('private', '../../x.pdf')).rejects.toThrow();
  });

  it('deletes, and deleting twice is not an error', async () => {
    await driver.put('public', 'img/2026/09/gone_thumb.webp', Buffer.from('x'));
    await driver.delete('public', 'img/2026/09/gone_thumb.webp');
    await driver.delete('public', 'img/2026/09/gone_thumb.webp');
    expect(await driver.exists('public', 'img/2026/09/gone_thumb.webp')).toBe(false);
  });
});

describe('UrlSigner', () => {
  const signer = new UrlSigner('x'.repeat(32));
  const now = new Date('2026-09-22T10:00:00Z');
  const key = 'doc/2026/09/abc_original.pdf';

  it('accepts its own signature before expiry', () => {
    const { expires, signature } = signer.sign('private', key, 600, now);
    expect(signer.verify('private', key, expires, signature, now)).toBe(true);
  });

  it('refuses the same signature after expiry', () => {
    const { expires, signature } = signer.sign('private', key, 600, now);
    const later = new Date(now.getTime() + 601_000);
    expect(signer.verify('private', key, expires, signature, later)).toBe(false);
  });

  it('refuses the signature on another file', () => {
    const { expires, signature } = signer.sign('private', key, 600, now);
    expect(
      signer.verify('private', 'doc/2026/09/other_original.pdf', expires, signature, now),
    ).toBe(false);
  });

  it('refuses a pushed-back expiry', () => {
    const { expires, signature } = signer.sign('private', key, 600, now);
    expect(signer.verify('private', key, expires + 3600, signature, now)).toBe(false);
  });

  it('refuses a signature from another secret', () => {
    const { expires, signature } = new UrlSigner('y'.repeat(32)).sign('private', key, 600, now);
    expect(signer.verify('private', key, expires, signature, now)).toBe(false);
  });

  it('refuses a malformed signature without throwing', () => {
    expect(signer.verify('private', key, Math.floor(now.getTime() / 1000) + 60, 'abc', now)).toBe(
      false,
    );
  });
});
