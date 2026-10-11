import { notifyShopper, SHOPPING_NOTIFICATION, type ShoppingNotificationEvent } from '../../../core/notifications/index.js';
import * as repo from '../repositories/print-jobs.repository.js';
import type { PrintJobRow } from '../schemas/print-jobs.schema.js';
import { hoursLeft } from './job-rules.js';
import { onPrintJobEvent, type PrintJobEventPayload } from './print-job-events.js';

/**
 * The customer hears about their own print order (2026-10-07) — the second
 * listener on [onPrintJobEvent], beside the production one.
 *
 * Three moves, each one asking the customer to do something:
 * - **priced** — the amount and the payment window: an order nobody pays in
 *   time lapses overnight, and the customer who sent it is not watching the app.
 * - **ready** — the pickup code and the branch: what they give the cashier.
 * - **declined** — staff cancelled it, with the reason they wrote.
 *
 * Only orders sent from the app by an account: a counter print has nobody to
 * tell (the customer stood there), and a cancellation the customer made is
 * news to nobody (`cancelled_by` is null for it).
 */
export function installPrintOrderCustomerNotifier(): () => void {
  return onPrintJobEvent(handle);
}

async function handle(p: PrintJobEventPayload): Promise<void> {
  if (p.source !== 'app' || p.customerId === null) return;
  if (p.event !== 'priced' && p.event !== 'ready' && p.event !== 'cancelled') return;
  // Read again: the payload names the move, the row holds what it produced.
  const job = await repo.findJob(p.jobId);
  if (!job || job.customer_id === null) return;
  const event = customerEventFor(p.event, job);
  if (event === null) return;
  notifyShopper({
    customerId: job.customer_id,
    event,
    text: {
      number: job.number,
      amountSyp: job.quoted_total_syp === null ? null : Number(job.quoted_total_syp),
      hoursLeft: hoursLeft(job.payment_due_at, new Date()),
      pickupCode: job.pickup_code,
      branch: await repo.findBranchName(job.branch_id),
      reason: job.cancel_reason,
    },
    data: { job_id: String(job.id) },
  });
}

/** Which notification the move is for the customer — `null` when it is none. */
export function customerEventFor(
  event: PrintJobEventPayload['event'],
  job: Pick<PrintJobRow, 'status' | 'cancelled_by'>,
): ShoppingNotificationEvent | null {
  switch (event) {
    // Priced again after a change is still «pay this now».
    case 'priced':
      return job.status === 'awaiting_payment' ? SHOPPING_NOTIFICATION.printOrderPriced : null;
    case 'ready':
      return job.status === 'ready' ? SHOPPING_NOTIFICATION.printOrderReady : null;
    case 'cancelled':
      return job.cancelled_by === null ? null : SHOPPING_NOTIFICATION.printOrderRejected;
    default:
      return null;
  }
}
