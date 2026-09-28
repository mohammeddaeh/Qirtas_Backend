/**
 * `npm run storage:setup` — creates the bucket `STORAGE_DRIVER=s3` writes to,
 * if it is missing. Idempotent. Development and first deployment only: the
 * server itself never creates buckets, so a typo in `S3_BUCKET` fails loudly on
 * the first upload instead of quietly writing to a new, empty bucket.
 *
 * Speaks plain S3, so it works against SeaweedFS (docker-compose), MinIO, R2 or AWS.
 */
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

async function main(): Promise<void> {
  if (env.STORAGE_DRIVER !== 's3') {
    console.log(`STORAGE_DRIVER=${env.STORAGE_DRIVER} — no bucket to create.`);
    return;
  }
  const bucket = env.S3_BUCKET!;
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`Bucket "${bucket}" already exists.`);
  } catch (error) {
    if (!(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 404)
      throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Bucket "${bucket}" created.`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
