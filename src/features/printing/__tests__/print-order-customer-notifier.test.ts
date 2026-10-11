import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifyShopper = vi.fn();
const findJob = vi.fn();
const findBranchName = vi.fn();

vi.mock('../../../core/logger/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../core/notifications/index.js', () => ({
  notifyShopper: (p: unknown) => notifyShopper(p),
  SHOPPING_NOTIFICATION: {
    backInStock: 'back_in_stock',
    printOrderPriced: 'print_order_priced',
    printOrderReady: 'print_order_ready',
    printOrderRejected: 'print_order_rejected',
  },
}));
vi.mock('../repositories/print-jobs.repository.js', () => ({
  findJob: (id: number) => findJob(id),
  findBranchName: (id: number) => findBranchName(id),
}));

const { installPrintOrderCustomerNotifier } = await import('../services/print-order-customer-notifier.js');
const { emitPrintJobEvent } = await import('../services/print-job-events.js');

const tick = () => new Promise((r) => setTimeout(r, 5));
const appJob = { id: 4, branch_id: 1, customer_id: 142, source: 'app' as const, number: 'BR1-P-2026-000004' };
const row = (over: Record<string, unknown> = {}) => ({
  ...appJob,
  status: 'awaiting_payment',
  quoted_total_syp: '12500.00',
  payment_due_at: new Date(Date.now() + 40 * 3600 * 1000),
  pickup_code: null,
  cancel_reason: null,
  cancelled_by: null,
  ...over,
});

/**
 * A customer who is never told their order is priced lets it lapse overnight,
 * and nothing fails: the order expires exactly as designed. Each case with its
 * opposite, so a listener that tells everyone everything does not pass.
 */
describe('print order customer notifier', () => {
  let off: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    off = installPrintOrderCustomerNotifier();
    findBranchName.mockResolvedValue('المالكي');
  });
  afterEach(() => off());

  it('priced tells the customer the amount and the hours left to pay', async () => {
    findJob.mockResolvedValue(row());
    emitPrintJobEvent('priced', appJob);
    await tick();
    expect(notifyShopper).toHaveBeenCalledTimes(1);
    const call = notifyShopper.mock.calls[0]![0];
    expect(call.customerId).toBe(142);
    expect(call.event).toBe('print_order_priced');
    expect(call.text.amountSyp).toBe(12500);
    expect(call.text.hoursLeft).toBeGreaterThan(38);
    expect(call.data).toEqual({ job_id: '4' });
  });

  it('ready carries the pickup code and the branch', async () => {
    findJob.mockResolvedValue(row({ status: 'ready', pickup_code: '1005-042', payment_due_at: null }));
    emitPrintJobEvent('ready', appJob);
    await tick();
    const call = notifyShopper.mock.calls[0]![0];
    expect(call.event).toBe('print_order_ready');
    expect(call.text.pickupCode).toBe('1005-042');
    expect(call.text.branch).toBe('المالكي');
  });

  it('cancelled by staff is declined with their reason; cancelled by the customer tells nobody', async () => {
    findJob.mockResolvedValue(row({ status: 'cancelled', cancelled_by: 7, cancel_reason: 'الملف تالف' }));
    emitPrintJobEvent('cancelled', appJob);
    await tick();
    expect(notifyShopper.mock.calls[0]![0].event).toBe('print_order_rejected');
    expect(notifyShopper.mock.calls[0]![0].text.reason).toBe('الملف تالف');

    notifyShopper.mockClear();
    findJob.mockResolvedValue(row({ status: 'cancelled', cancelled_by: null }));
    emitPrintJobEvent('cancelled', appJob);
    await tick();
    expect(notifyShopper).not.toHaveBeenCalled();
  });

  it('a counter print and an order with no account tell nobody', async () => {
    findJob.mockResolvedValue(row());
    emitPrintJobEvent('priced', { ...appJob, source: 'counter' });
    emitPrintJobEvent('priced', { ...appJob, customer_id: null });
    await tick();
    expect(notifyShopper).not.toHaveBeenCalled();
  });

  it('moves that ask nothing of the customer stay quiet', async () => {
    findJob.mockResolvedValue(row({ status: 'printing' }));
    for (const e of ['submitted', 'paid', 'started', 'picked_up', 'expired', 'deferred'] as const) {
      emitPrintJobEvent(e, appJob);
    }
    await tick();
    expect(notifyShopper).not.toHaveBeenCalled();
  });

  it('priced read back in another state (paid at once) is not a request to pay', async () => {
    findJob.mockResolvedValue(row({ status: 'queued' }));
    emitPrintJobEvent('priced', appJob);
    await tick();
    expect(notifyShopper).not.toHaveBeenCalled();
  });
});
