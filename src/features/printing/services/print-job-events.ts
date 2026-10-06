import { logger } from '../../../core/logger/logger.js';
import type { PrintJobRow } from '../schemas/print-jobs.schema.js';

/**
 * Every move a print order makes, by name (9-ح-2) — the one place a later
 * listener hooks into: customer notifications («جاهز — استلمه»), a laptop
 * station's live board, a printing report. None of them exists yet; what
 * exists is the vocabulary, so adding one never means touching the board or
 * the services that move the order.
 *
 * The audit log keeps «who did it» for staff moves (`printing.job.*`); this
 * covers every move, including the ones nobody performed by hand — paid at
 * the till, expired overnight.
 */
export const PRINT_JOB_EVENTS = [
  'submitted', // the customer sent it — the board has something to price
  'priced', // priced, waiting for payment
  'paid', // settled at the till
  'deferred', // allowed to print before payment
  'started', // printing began; materials left the shelf
  'ready', // printed — the pickup code is issued
  'picked_up', // handed over
  'cancelled',
  'expired', // the payment window closed
] as const;
export type PrintJobEvent = (typeof PRINT_JOB_EVENTS)[number];

export interface PrintJobEventPayload {
  event: PrintJobEvent;
  jobId: number;
  branchId: number;
  customerId: number | null;
  source: PrintJobRow['source'];
  number: string | null;
  at: Date;
}

type Listener = (payload: PrintJobEventPayload) => void | Promise<void>;
const listeners: Listener[] = [];

/** Subscribe — returns the unsubscribe. Tests and future notification wiring. */
export function onPrintJobEvent(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/**
 * Announce a move. **Never fails the caller and never blocks it**: listeners
 * run on the next tick, and a listener that throws is logged and skipped —
 * an order printed is printed whether or not the text message went out.
 *
 * Called after the write it describes; a call inside a transaction (the till
 * settles inside the sale's) may run before that commit, so a listener reads
 * the order again rather than trusting the payload for state.
 */
export function emitPrintJobEvent(
  event: PrintJobEvent,
  job: Pick<PrintJobRow, 'id' | 'branch_id' | 'customer_id' | 'source' | 'number'>,
): void {
  if (listeners.length === 0) return;
  const payload: PrintJobEventPayload = {
    event,
    jobId: job.id,
    branchId: job.branch_id,
    customerId: job.customer_id,
    source: job.source,
    number: job.number,
    at: new Date(),
  };
  for (const listener of [...listeners]) {
    setImmediate(() => {
      Promise.resolve()
        .then(() => listener(payload))
        .catch((err: unknown) => logger.error({ err, event, jobId: job.id }, 'print job event listener failed'));
    });
  }
}

/** The event a staff stage move announces. */
export function eventForStage(to: 'in_production' | 'ready' | 'picked_up'): PrintJobEvent {
  return to === 'in_production' ? 'started' : to;
}
