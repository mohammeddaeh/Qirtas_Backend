import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifyWork = vi.fn();
const findJob = vi.fn();
const findCustomer = vi.fn();
const findBranchStaffIds = vi.fn();
const holdsPermissionAt = vi.fn();

vi.mock('../../../core/logger/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../core/notifications/index.js', () => ({
  notifyWork: (p: unknown) => notifyWork(p),
  WORK_NOTIFICATION: { printJobSubmitted: 'print_job_submitted', printJobPrintable: 'print_job_printable' },
}));
vi.mock('../../../core/http/require-permission.js', () => ({
  holdsPermissionAt: (...a: unknown[]) => holdsPermissionAt(...a),
}));
vi.mock('../repositories/print-jobs.repository.js', () => ({
  findJob: (id: number) => findJob(id),
  findCustomer: (id: number) => findCustomer(id),
  findBranchStaffIds: (id: number) => findBranchStaffIds(id),
}));

const { installPrintJobNotifier } = await import('../services/print-job-notifier.js');
const { emitPrintJobEvent } = await import('../services/print-job-events.js');

const tick = () => new Promise((r) => setTimeout(r, 5));
const appJob = { id: 4, branch_id: 1, customer_id: 142, source: 'app' as const, number: 'BR1-P-2026-000004' };
const row = (over: Record<string, unknown> = {}) => ({
  ...appJob,
  status: 'awaiting_quote',
  label: null,
  contact_name: null,
  ...over,
});

describe('print job notifier (9-ط-1)', () => {
  let off: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    off = installPrintJobNotifier();
    findCustomer.mockResolvedValue({ id: 142, name: 'أحمد الخطيب', phone: null, status: 'active' });
    findBranchStaffIds.mockResolvedValue([10, 11, 12]);
    // 12 is at the branch but cannot work the presses.
    holdsPermissionAt.mockImplementation(async (id: number) => id !== 12);
  });
  afterEach(() => off());

  it('an app order sent tells production at its branch — not those without the key', async () => {
    findJob.mockResolvedValue(row());
    emitPrintJobEvent('submitted', appJob);
    await tick();
    expect(notifyWork).toHaveBeenCalledTimes(1);
    const call = notifyWork.mock.calls[0]![0];
    expect(call.event).toBe('print_job_submitted');
    expect(call.accountIds).toEqual([10, 11]);
    expect(call.text.customer).toBe('أحمد الخطيب');
    expect(call.data).toEqual({ job_id: '4', branch_id: '1' });
  });

  it('paid into the queue is printable work — and the cashier who took the money is not told', async () => {
    findJob.mockResolvedValue(row({ status: 'queued', payment_status: 'paid' }));
    emitPrintJobEvent('paid', appJob, 11);
    await tick();
    const call = notifyWork.mock.calls[0]![0];
    expect(call.event).toBe('print_job_printable');
    expect(call.accountIds).toEqual([10]);
    expect(call.text.deferred).toBe(false);
  });

  it('paid when already printed is collection, not work — nobody is woken', async () => {
    findJob.mockResolvedValue(row({ status: 'ready' }));
    emitPrintJobEvent('paid', appJob);
    await tick();
    expect(notifyWork).not.toHaveBeenCalled();
  });

  it('a counter print is printed while the customer waits — no notification for any move', async () => {
    findJob.mockResolvedValue(row({ source: 'counter', status: 'queued' }));
    emitPrintJobEvent('paid', { ...appJob, source: 'counter' });
    emitPrintJobEvent('submitted', { ...appJob, source: 'counter' });
    await tick();
    expect(notifyWork).not.toHaveBeenCalled();
  });

  it('deferred is printable too, said as «before payment»', async () => {
    findJob.mockResolvedValue(row({ status: 'queued', payment_status: 'deferred', label: 'ملخص' }));
    emitPrintJobEvent('deferred', appJob, 10);
    await tick();
    const call = notifyWork.mock.calls[0]![0];
    expect(call.event).toBe('print_job_printable');
    expect(call.text.deferred).toBe(true);
    expect(call.text.what).toBe('ملخص — BR1-P-2026-000004');
    expect(call.accountIds).toEqual([11]);
  });

  it('moves that are not new work (priced, started, ready…) stay silent', async () => {
    findJob.mockResolvedValue(row({ status: 'in_production' }));
    for (const e of ['priced', 'started', 'ready', 'picked_up', 'cancelled', 'expired'] as const) {
      emitPrintJobEvent(e, appJob);
    }
    await tick();
    expect(notifyWork).not.toHaveBeenCalled();
  });

  it('no one left to tell — nothing is sent', async () => {
    findJob.mockResolvedValue(row());
    findBranchStaffIds.mockResolvedValue([10]);
    emitPrintJobEvent('submitted', appJob, 10);
    await tick();
    expect(notifyWork).not.toHaveBeenCalled();
  });
});
