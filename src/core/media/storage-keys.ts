import { randomUUID } from 'node:crypto';

/**
 * Object keys look like `img/2026/09/5f0c…e1_medium.webp`.
 *
 * The grammar is deliberately narrow — lowercase letters, digits, `-`, `_`,
 * single `/` separators, one extension — because the local driver turns a key
 * into a path. A key that cannot contain `..`, a leading `/`, a backslash or a
 * drive letter cannot escape the storage root, whatever a caller passes in.
 */
const KEY_PATTERN = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*\.[a-z0-9]{2,5}$/;

export function isValidStorageKey(key: string): boolean {
  return key.length <= 200 && KEY_PATTERN.test(key);
}

/**
 * The base every variant of one upload shares — `img/2026/09/<uuid>`.
 *
 * Year/month folders keep a single directory from holding every file ever
 * uploaded; the UUID makes a key unguessable and never reused, which is what
 * lets public files be cached as immutable.
 */
export function newStorageKeyBase(prefix: 'img' | 'doc', now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}/${year}/${month}/${randomUUID()}`;
}

export function variantKey(base: string, variant: string, extension: string): string {
  return `${base}_${variant}.${extension}`;
}
