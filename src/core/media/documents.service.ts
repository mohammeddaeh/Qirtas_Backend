import { BusinessError } from '../http/api-error.js';
import { storageDriver, type UploadTarget } from './ports/storage-driver.js';
import { newStorageKeyBase } from './storage-keys.js';
import { DEFAULT_SIGNED_URL_TTL_SECONDS } from './signed-url.js';
import { declaredType, mimeFor, sniff, SNIFF_BYTES, type DocumentType } from './document-types.js';
import * as mediaAssetsRepository from './repositories/media-assets.repository.js';
import type { MediaAssetRow } from './schemas/media-assets.schema.js';

/**
 * Customer documents — the three steps every direct upload takes:
 *
 *   reserve (row `pending` + upload link) → client PUTs the bytes to the store
 *   → complete (size + bytes checked → `ready` or `rejected`)
 *
 * Generic on purpose: nothing here knows what a print job is. The owning
 * feature checks the caller's right to the thing the file belongs to, passes
 * its own limits (`DocumentPolicy`), and keeps the asset id. Files are always
 * in the **private** zone.
 */

export interface DocumentPolicy {
  maxBytes: number;
  allowed: readonly DocumentType[];
}

export type DocumentUploader = { customerId: number } | { userId: number };

/** The upload link lives 15 minutes — long enough for 50 MB on a slow phone line. */
export const UPLOAD_LINK_TTL_SECONDS = 15 * 60;
/** A reservation nobody completes is swept after a day (the link died long before). */
export const UPLOAD_ABANDON_MS = 24 * 60 * 60 * 1000;
/**
 * A verified file nobody claims (a draft abandoned before submitting) is swept
 * after a week. The owning feature replaces this deadline with its own
 * retention as soon as it takes the file (`setDocumentExpiry`).
 */
export const UNCLAIMED_DOCUMENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The client always uploads as opaque bytes. The real type is read from the
 * bytes at `complete`; asking the client for a MIME type would only give it a
 * value to get wrong, and it is part of the signature.
 */
const UPLOAD_CONTENT_TYPE = 'application/octet-stream';

export interface ReservedDocument {
  asset: MediaAssetRow;
  upload: UploadTarget;
}

/**
 * Refuses early what would certainly be refused later — too large, or a name
 * that is not an allowed type — so the phone does not spend 50 MB of data on a
 * file the server will reject. Neither check is the verdict: that is `complete`.
 */
export async function reserveDocument(input: {
  filename: string;
  bytes: number;
  uploader: DocumentUploader;
  policy: DocumentPolicy;
  now?: Date;
}): Promise<ReservedDocument> {
  const { policy } = input;
  if (input.bytes > policy.maxBytes) {
    throw new BusinessError(422, 'The file is larger than allowed', 'document_too_large', {
      max_bytes: policy.maxBytes,
    });
  }
  const declared = declaredType(input.filename);
  if (declared === null || !policy.allowed.includes(declared)) {
    throw new BusinessError(422, 'This file type is not accepted', 'document_type_not_allowed', {
      allowed: [...policy.allowed],
    });
  }

  const now = input.now ?? new Date();
  // `.bin` whatever the file is: the key never states a type the bytes have
  // not proven, and the name a reader sees comes from `original_filename`.
  const key = `${newStorageKeyBase('doc', now)}.bin`;
  const asset = await mediaAssetsRepository.insert({
    zone: 'private',
    kind: 'document',
    key_base: key,
    original_filename: input.filename.slice(0, 255),
    original_bytes: input.bytes,
    variants: [],
    status: 'pending',
    uploaded_by_user_id: 'userId' in input.uploader ? input.uploader.userId : null,
    uploaded_by_customer_id: 'customerId' in input.uploader ? input.uploader.customerId : null,
    expires_at: new Date(now.getTime() + UPLOAD_ABANDON_MS),
  });
  const upload = await storageDriver().uploadTarget('private', key, {
    bytes: input.bytes,
    contentType: UPLOAD_CONTENT_TYPE,
    ttlSeconds: UPLOAD_LINK_TTL_SECONDS,
  });
  return { asset, upload };
}

/**
 * Checks what actually arrived and settles the row. Returns the row in its
 * final state — `ready` or `rejected` — and the caller tells the client which.
 *
 * - Nothing arrived yet → `409 document_not_uploaded` (the row stays `pending`,
 *   so the client can finish the PUT and call again).
 * - Already settled → returned as is. A retried request is not an error.
 * - Rejected → the object is deleted **now**: a file we will never serve has
 *   no reason to wait for the sweeper, and it may be exactly what we refuse to
 *   keep.
 */
export async function completeDocument(
  asset: MediaAssetRow,
  policy: DocumentPolicy,
  now: Date = new Date(),
): Promise<MediaAssetRow> {
  if (asset.kind !== 'document') throw new Error(`media_assets ${asset.id} is not a document`);
  if (asset.status !== 'pending') return asset;

  const driver = storageDriver();
  const size = await driver.size('private', asset.key_base);
  if (size === null) {
    throw new BusinessError(409, 'The file has not been uploaded yet', 'document_not_uploaded');
  }

  const head =
    size > 0 && size <= policy.maxBytes
      ? await driver.readHead('private', asset.key_base, SNIFF_BYTES)
      : null;
  const type =
    head === null
      ? null
      : await sniff(head, declaredType(asset.original_filename ?? ''), policy.allowed);

  if (type === null) {
    await driver.delete('private', asset.key_base);
    const settled = await mediaAssetsRepository.settlePending(asset.id, {
      status: 'rejected',
      original_bytes: size,
      expires_at: null,
    });
    return settled ?? (await reread(asset.id));
  }

  const settled = await mediaAssetsRepository.settlePending(asset.id, {
    status: 'ready',
    document_type: type,
    mime_type: mimeFor(type),
    original_bytes: size,
    expires_at: new Date(now.getTime() + UNCLAIMED_DOCUMENT_MS),
  });
  return settled ?? (await reread(asset.id));
}

/**
 * A link to read one verified document for ten minutes, offered under its
 * original name. **The caller checked the reader's right first** — the link is
 * the permission, and it works for anyone who holds it until it expires.
 */
export async function documentDownloadUrl(asset: MediaAssetRow): Promise<string> {
  if (asset.kind !== 'document' || asset.status !== 'ready') {
    throw new Error(`media_assets ${asset.id} is not a ready document`);
  }
  return storageDriver().downloadUrl(asset.key_base, {
    filename: asset.original_filename,
    contentType: asset.mime_type,
    ttlSeconds: DEFAULT_SIGNED_URL_TTL_SECONDS,
  });
}

/**
 * The owning feature's retention: `at` = when the sweeper may delete, `null` =
 * keep until told otherwise (a print job in production). Deleted rows ignore it.
 */
export async function setDocumentExpiry(ids: number[], at: Date | null): Promise<void> {
  await mediaAssetsRepository.setExpiry([...new Set(ids)], at);
}

export async function findDocument(id: number): Promise<MediaAssetRow | null> {
  const row = await mediaAssetsRepository.findById(id);
  return row?.kind === 'document' ? row : null;
}

async function reread(id: number): Promise<MediaAssetRow> {
  const row = await mediaAssetsRepository.findById(id);
  if (!row) throw new Error(`media_assets ${id} vanished while settling`);
  return row;
}
