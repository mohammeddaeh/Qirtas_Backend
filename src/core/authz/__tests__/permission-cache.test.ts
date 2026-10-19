import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedPermissionKeys, clearPermissionCache } from '../permission-cache.js';

/**
 * A permission cache fails in the dangerous direction silently: a revoked grant
 * that keeps working shows nothing wrong anywhere. So the saving is pinned with
 * its opposites — the set is reused within the window, **and** forgotten after
 * it, **and** forgotten at once when a grant is written, **and** a failed load
 * is never served again.
 */
describe('cachedPermissionKeys', () => {
  afterEach(() => {
    clearPermissionCache();
    vi.useRealTimers();
  });

  it('reuses the set within the window — one query for a burst', async () => {
    const load = vi.fn(async () => ['sales.sell']);
    await cachedPermissionKeys('all:1', load);
    await cachedPermissionKeys('all:1', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks again after the window — a revoked grant stops working within seconds', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => ['sales.sell']);
    await cachedPermissionKeys('all:1', load);
    vi.advanceTimersByTime(5_001);
    await cachedPermissionKeys('all:1', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a grant write forgets every set at once', async () => {
    const load = vi.fn(async () => ['sales.sell']);
    await cachedPermissionKeys('all:1', load);
    clearPermissionCache();
    await cachedPermissionKeys('all:1', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps users and branches apart', async () => {
    const a = await cachedPermissionKeys('at:1:3', async () => ['a']);
    const b = await cachedPermissionKeys('at:1:4', async () => ['b']);
    const c = await cachedPermissionKeys('at:2:3', async () => ['c']);
    expect([a, b, c]).toEqual([['a'], ['b'], ['c']]);
  });

  it('a failed load is not remembered', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(['sales.sell']);
    await expect(cachedPermissionKeys('all:1', load)).rejects.toThrow('db down');
    await expect(cachedPermissionKeys('all:1', load)).resolves.toEqual(['sales.sell']);
  });
});
