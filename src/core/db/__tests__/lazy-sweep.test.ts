import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazySweep } from '../lazy-sweep.js';

/**
 * A read-time sweep that runs too often costs a query on every board poll; one
 * that runs too rarely leaves an expired order holding stock. Both are silent,
 * so each case is pinned with its opposite.
 */
describe('lazySweep', () => {
  afterEach(() => vi.useRealTimers());

  it('runs on the first read, and not again within the gap', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => 0);
    const run = lazySweep(sweep, 15_000);
    await run();
    await run();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('runs again once the gap has passed — an expired row is never left for long', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => 0);
    const run = lazySweep(sweep, 15_000);
    await run();
    vi.advanceTimersByTime(15_001);
    await run();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('reads arriving while a sweep runs wait for it instead of starting their own', async () => {
    let finish!: () => void;
    const sweep = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const run = lazySweep(sweep, 15_000);
    const a = run();
    const b = run();
    let bDone = false;
    void b.then(() => (bDone = true));
    await Promise.resolve();
    expect(bDone).toBe(false);
    finish();
    await Promise.all([a, b]);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
