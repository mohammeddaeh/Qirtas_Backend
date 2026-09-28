import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  DownloadUrlOptions,
  StorageDriver,
  StorageZone,
  StoredObject,
  UploadTarget,
  UploadTargetOptions,
} from '../ports/storage-driver.js';
import { STORAGE_ZONES } from '../ports/storage-driver.js';
import { isValidStorageKey } from '../storage-keys.js';
import { contentDisposition } from '../content-disposition.js';

export interface S3DriverConfig {
  bucket: string;
  region: string;
  /** Where **this server** reaches the store, e.g. `http://minio:9000`. Unset = AWS. */
  endpoint?: string;
  /**
   * Where **the phone** reaches the store. Presigned URLs carry their host in
   * the signature, so a link signed for `http://minio:9000` (a name only the
   * server's network resolves) cannot be rewritten afterwards — it has to be
   * signed for the public host. Unset = same as `endpoint`.
   */
  publicEndpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `true` for MinIO (`host/bucket/key`); AWS and R2 accept virtual-host style. */
  forcePathStyle: boolean;
}

/**
 * Any S3-compatible store — MinIO in development (`docker-compose.yml`), and
 * whichever provider production picks (R2, AWS, MinIO on a server).
 *
 * Chosen because the server runs on **more than one machine** (2026-09-28): a
 * file written to one machine's disk does not exist on the next. One bucket,
 * zones as key prefixes (`public/…`, `private/…`), and the bucket itself stays
 * **private** — public images are still served through `GET /files/public/*`,
 * so no bucket policy decides who reads what.
 */
export class S3Driver implements StorageDriver {
  private readonly client: S3Client;
  private readonly signingClient: S3Client;
  private readonly bucket: string;

  constructor(config: S3DriverConfig) {
    this.bucket = config.bucket;
    const base = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // The SDK's default adds a CRC32 of the body to every PutObject — for a
      // presigned PUT that is the checksum of an **empty** body, baked into the
      // URL, and every real upload then fails verification. Only when required.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({ ...base, endpoint: config.endpoint });
    this.signingClient = new S3Client({
      ...base,
      endpoint: config.publicEndpoint ?? config.endpoint,
    });
  }

  async put(zone: StorageZone, key: string, bytes: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(zone, key), Body: bytes }),
    );
  }

  async open(zone: StorageZone, key: string): Promise<StoredObject | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(zone, key) }),
      );
      if (!(out.Body instanceof Readable)) throw new Error('S3 body is not a Node stream');
      return { stream: out.Body, size: out.ContentLength ?? 0 };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(zone: StorageZone, key: string): Promise<void> {
    // S3 answers 204 for a key that is not there, so deleting twice is not an
    // error — the same contract as the local driver.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(zone, key) }),
    );
  }

  async exists(zone: StorageZone, key: string): Promise<boolean> {
    return (await this.size(zone, key)) !== null;
  }

  async size(zone: StorageZone, key: string): Promise<number | null> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(zone, key) }),
      );
      return out.ContentLength ?? 0;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async readHead(zone: StorageZone, key: string, bytes: number): Promise<Buffer | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(zone, key),
          Range: `bytes=0-${bytes - 1}`,
        }),
      );
      if (!out.Body) return Buffer.alloc(0);
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (error) {
      if (isMissing(error)) return null;
      // An empty object has no byte 0, and S3 answers the range with 416.
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 416) {
        return Buffer.alloc(0);
      }
      throw error;
    }
  }

  /**
   * `Content-Length` and `Content-Type` are **signed**: the store refuses a
   * body of any other size, which is what enforces the upload limit without
   * the bytes passing through this server.
   */
  async uploadTarget(
    zone: StorageZone,
    key: string,
    options: UploadTargetOptions,
  ): Promise<UploadTarget> {
    const url = await getSignedUrl(
      this.signingClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(zone, key),
        ContentType: options.contentType,
        ContentLength: options.bytes,
      }),
      {
        expiresIn: options.ttlSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      method: 'PUT',
      url,
      headers: { 'Content-Type': options.contentType },
      expires_at: new Date(Date.now() + options.ttlSeconds * 1000),
    };
  }

  async downloadUrl(key: string, options: DownloadUrlOptions): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey('private', key),
        ResponseContentDisposition: contentDisposition(options.filename),
        ResponseContentType: options.contentType ?? undefined,
        // A shared device keeps no copy after the link expires.
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: options.ttlSeconds },
    );
  }

  private objectKey(zone: StorageZone, key: string): string {
    if (!STORAGE_ZONES.includes(zone)) throw new Error(`Unknown storage zone: ${zone}`);
    if (!isValidStorageKey(key)) throw new Error(`Invalid storage key: ${key}`);
    return `${zone}/${key}`;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'NoSuchKey' ||
      error.name === 'NotFound' ||
      error.$metadata.httpStatusCode === 404)
  );
}
