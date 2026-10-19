import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCache, ttlCache } from '../ttl-cache.js';

/**
 * A stale price context shows a wrong price on the shelf with nothing failing,
 * so the saving is pinned with its opposites: reused within the window, read
 * again after it, read again at once after a write, and never serving a
 * failed load.
 */
describe('ttlCache', () => {
  afterEach(() => vi.useRealTimers());

  it('one load for a burst within the window', async () => {
    const load = vi.fn(async () => 1);
    const c = ttlCache('t1', 15_000, load);
    await Promise.all([c.get(), c.get(), c.get()]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads again after the window', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => 1);
    const c = ttlCache('t2', 15_000, load);
    await c.get();
    vi.advanceTimersByTime(15_001);
    await c.get();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a write clears it by name — the next read sees the database', async () => {
    let rate = 100;
    const c = ttlCache('t3', 15_000, async () => rate);
    expect(await c.get()).toBe(100);
    rate = 120;
    clearCache('t3');
    expect(await c.get()).toBe(120);
  });

  it('clearing another name leaves it alone', async () => {
    const load = vi.fn(async () => 1);
    const c = ttlCache('t4', 15_000, load);
    await c.get();
    clearCache('something-else');
    await c.get();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a failed load is not served again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(7);
    const c = ttlCache('t5', 15_000, load);
    await expect(c.get()).rejects.toThrow('db down');
    await expect(c.get()).resolves.toBe(7);
  });
});
