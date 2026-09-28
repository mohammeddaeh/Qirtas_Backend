import { db } from '../db/client.js';
import { logger } from '../logger/logger.js';
import { storageDriver } from './ports/storage-driver.js';
import * as mediaAssetsRepository from './repositories/media-assets.repository.js';

/**
 * Deletes documents past `expires_at` — abandoned reservations and files whose
 * retention ran out. The object goes; **the row stays** as `deleted` with a
 * reason, so an old print job still says «the file was removed after 30 days»
 * instead of pointing at nothing.
 *
 * Runs inside every server process, and there is **more than one server
 * machine** (2026-09-28). So each round first takes a transaction-scoped
 * advisory lock: one machine sweeps, the others see `false` and skip the round.
 * Without it two machines pick the same rows, both delete, and both write the
 * history — harmless today, a double audit line the day the sweep records one.
 */
export const DOCUMENT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_NAME = 'core.media.document_sweep';
/** A round is bounded; a large backlog drains over the next rounds, oldest first. */
const BATCH = 200;

export interface SweepResult {
  /** Another machine held the lock — nothing was looked at. */
  skipped: boolean;
  deleted: number;
  /** Objects the store refused to delete — left `pending`/`ready` for the next round. */
  failed: number;
}

export async function sweepExpiredDocuments(now: Date = new Date()): Promise<SweepResult> {
  return db.transaction(async (tx) => {
    if (!(await mediaAssetsRepository.tryTransactionLock(tx, LOCK_NAME))) {
      return { skipped: true, deleted: 0, failed: 0 };
    }
    const rows = await mediaAssetsRepository.findExpired(tx, now, BATCH);
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        // Images have variants; documents are one object under `key_base`.
        const keys = row.kind === 'image' ? row.variants.map((v) => v.key) : [row.key_base];
        for (const key of keys) await storageDriver().delete(row.zone, key);
      } catch (err) {
        failed++;
        logger.warn(
          { err, mediaAssetId: row.id },
          'Could not delete an expired file — retrying next round',
        );
        continue;
      }
      await mediaAssetsRepository.markDeleted(
        tx,
        row.id,
        row.status === 'pending' ? 'upload_abandoned' : 'retention_expired',
        now,
      );
      deleted++;
    }
    return { skipped: false, deleted, failed };
  });
}

/** `unref()` so the timer never keeps the process alive during a graceful shutdown. */
export function startDocumentSweep(): void {
  setInterval(() => {
    void sweepExpiredDocuments().then(
      (result) => {
        if (result.deleted > 0 || result.failed > 0) logger.info(result, 'Document sweep');
      },
      (err: unknown) =>
        logger.warn({ err }, 'Document sweep failed — will retry on the next interval'),
    );
  }, DOCUMENT_SWEEP_INTERVAL_MS).unref();
}
