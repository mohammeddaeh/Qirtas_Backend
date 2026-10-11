import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifyShopper = vi.fn();
const findOpenDemandInStock = vi.fn();
const claimNotified = vi.fn();
const resolvePricesAt = vi.fn();

vi.mock('../../../core/logger/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../core/config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../../../core/notifications/index.js', () => ({
  notifyShopper: (p: unknown) => notifyShopper(p),
  SHOPPING_NOTIFICATION: { backInStock: 'back_in_stock' },
}));
vi.mock('../../../core/pricing/price-port.js', () => ({
  resolvePricesAt: (...a: unknown[]) => resolvePricesAt(...a),
}));
vi.mock('../repositories/demand.repository.js', () => ({
  findOpenDemandInStock: (n: number) => findOpenDemandInStock(n),
  claimNotified: (ids: number[], at: Date) => claimNotified(ids, at),
}));

const { sweepBackInStock } = await import('../services/back-in-stock.js');

const demand = (id: number, variant: number, branch = 1) => ({
  id,
  customer_id: 100 + id,
  variant_id: variant,
  branch_id: branch,
  product_id: variant * 10,
  product_name_ar: 'دفتر',
  product_name_en: 'Notebook',
  branch_name: 'المالكي',
});
const priced = (variantId: number, status: string) => [variantId, { variantId, status }] as const;

/**
 * A notify-me that never tells looks exactly like one that has nothing to tell:
 * the row waits and the customer buys elsewhere. Each case with its opposite,
 * so a sweep that tells everyone passes the first and fails the rest.
 */
describe('back-in-stock sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimNotified.mockImplementation(async (ids: number[]) => ids);
  });

  it('stock on the shelf and a price tells the customer, with the product to open', async () => {
    findOpenDemandInStock.mockResolvedValue([demand(1, 5)]);
    resolvePricesAt.mockResolvedValue(new Map([priced(5, 'priced')]));
    expect(await sweepBackInStock()).toEqual({ notified: 1 });
    const call = notifyShopper.mock.calls[0]![0];
    expect(call.customerId).toBe(101);
    expect(call.event).toBe('back_in_stock');
    expect(call.data).toEqual({ product_id: '50', variant_id: '5', branch_id: '1' });
  });

  it('stock without a price, or withdrawn, is not for sale: nobody is told and nothing is marked', async () => {
    findOpenDemandInStock.mockResolvedValue([demand(1, 5), demand(2, 6)]);
    resolvePricesAt.mockResolvedValue(new Map([priced(5, 'unpriced'), priced(6, 'not_listed')]));
    expect(await sweepBackInStock()).toEqual({ notified: 0 });
    expect(notifyShopper).not.toHaveBeenCalled();
    expect(claimNotified).toHaveBeenCalledWith([], expect.any(Date));
  });

  it('prices are asked per branch: a price at one branch does not sell at another', async () => {
    findOpenDemandInStock.mockResolvedValue([demand(1, 5, 1), demand(2, 5, 2)]);
    resolvePricesAt.mockImplementation(
      async (branchId: number) => new Map([priced(5, branchId === 1 ? 'priced' : 'unpriced')]),
    );
    await sweepBackInStock();
    expect(notifyShopper).toHaveBeenCalledTimes(1);
    expect(notifyShopper.mock.calls[0]![0].customerId).toBe(101);
  });

  it('a request another sweep already claimed is not told twice', async () => {
    findOpenDemandInStock.mockResolvedValue([demand(1, 5), demand(2, 5)]);
    resolvePricesAt.mockResolvedValue(new Map([priced(5, 'priced')]));
    claimNotified.mockResolvedValue([2]);
    expect(await sweepBackInStock()).toEqual({ notified: 1 });
    expect(notifyShopper.mock.calls.map((c) => c[0].customerId)).toEqual([102]);
  });

  it('nothing waiting asks nothing of the pricing port', async () => {
    findOpenDemandInStock.mockResolvedValue([]);
    expect(await sweepBackInStock()).toEqual({ notified: 0 });
    expect(resolvePricesAt).not.toHaveBeenCalled();
  });
});
