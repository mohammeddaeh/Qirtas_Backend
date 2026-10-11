import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { notifyWork, WORK_NOTIFICATION, type WorkNotificationEvent } from '../../../core/notifications/index.js';
import * as repo from '../repositories/print-jobs.repository.js';
import { onPrintJobEvent, type PrintJobEventPayload } from './print-job-events.js';

/** Who works the presses — the key the board's steps need. */
const WORK_KEY = 'printing.status.update';

/**
 * Work notifications for production (9-ط-1, 2026-10-07) — the first listener
 * on [onPrintJobEvent]. Someone printing with both hands does not watch a
 * board refreshing every thirty seconds; the work has to come to them.
 *
 * Three moves wake the branch's production staff: an order **sent from the
 * app** (it waits to be priced), an order **paid** that now enters the queue,
 * and one **allowed before payment**. A counter print is printed while the
 * customer stands there — nobody needs telling. Whoever made the move is not
 * told of it.
 */
export function installPrintJobNotifier(): () => void {
  return onPrintJobEvent(handle);
}

async function handle(p: PrintJobEventPayload): Promise<void> {
  const event = await workEventFor(p);
  if (event === null) return;
  // Read again: the event may fire inside the paying transaction.
  const job = await repo.findJob(p.jobId);
  if (!job) return;
  const recipients = await productionStaff(job.branch_id, p.actorUserId);
  if (recipients.length === 0) return;
  const account = job.customer_id === null ? undefined : await repo.findCustomer(job.customer_id);
  notifyWork({
    accountIds: recipients,
    event,
    text: {
      customer: account?.name ?? job.contact_name,
      what: job.label ? `${job.label} — ${job.number ?? job.id}` : (job.number ?? String(job.id)),
      deferred: p.event === 'deferred',
    },
    data: { job_id: String(job.id), branch_id: String(job.branch_id) },
  });
}

/** Which notification a move is, if any. */
async function workEventFor(p: PrintJobEventPayload): Promise<WorkNotificationEvent | null> {
  if (p.source === 'counter') return null;
  switch (p.event) {
    case 'submitted':
      return WORK_NOTIFICATION.printJobSubmitted;
    case 'deferred':
      return WORK_NOTIFICATION.printJobPrintable;
    case 'paid': {
      // Paid while already printed (ready) is collection, not new work.
      const job = await repo.findJob(p.jobId);
      return job?.status === 'queued' ? WORK_NOTIFICATION.printJobPrintable : null;
    }
    default:
      return null;
  }
}

/** The branch's staff who may work its presses — minus whoever just acted. */
async function productionStaff(branchId: number, actorUserId: number | null): Promise<number[]> {
  const candidates = (await repo.findBranchStaffIds(branchId)).filter((id) => id !== actorUserId);
  const allowed = await Promise.all(candidates.map((id) => holdsPermissionAt(id, WORK_KEY, branchId)));
  return candidates.filter((_, i) => allowed[i]);
}
