import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { BusinessError, NotFoundError } from '../../http/api-error.js';
import {
  BULK_FAILED_KEY,
  BULK_MAX_IDS,
  BULK_NOT_FOUND_KEY,
  bulkBodySchema,
  requireFieldForActions,
  runBulk,
} from '../bulk.js';

/**
 * A bulk runner that fails looks like a working one: the request is a 200 and
 * the list refreshes. What goes wrong is the per-row story — a refusal with no
 * key the client can branch on, a success reported for a row that was refused,
 * one failure rolling the whole answer into a 500 while earlier rows are
 * already committed. So each case sits beside its opposite.
 */

const schema = bulkBodySchema(['delete', 'set_status'] as const)
  .extend({ status: z.enum(['a', 'b']).optional() })
  .strict()
  .superRefine((v, ctx) => requireFieldForActions(v, ctx, 'status', ['set_status']));

describe('bulkBodySchema', () => {
  it('drops duplicate ids, keeping first-seen order', () => {
    const parsed = schema.parse({ action: 'delete', ids: [3, 1, 3, 2, 1] });
    expect(parsed.ids).toEqual([3, 1, 2]);
  });

  it('accepts exactly the maximum and refuses one more', () => {
    const ids = Array.from({ length: BULK_MAX_IDS }, (_, i) => i + 1);
    expect(schema.safeParse({ action: 'delete', ids }).success).toBe(true);
    expect(schema.safeParse({ action: 'delete', ids: [...ids, BULK_MAX_IDS + 1] }).success).toBe(
      false,
    );
  });

  it('refuses an empty list, a non-positive id and an unknown action', () => {
    expect(schema.safeParse({ action: 'delete', ids: [] }).success).toBe(false);
    expect(schema.safeParse({ action: 'delete', ids: [0] }).success).toBe(false);
    expect(schema.safeParse({ action: 'delete', ids: [1.5] }).success).toBe(false);
    expect(schema.safeParse({ action: 'explode', ids: [1] }).success).toBe(false);
  });

  it('requires the extra field for its action — and forbids it for the others', () => {
    const missing = schema.safeParse({ action: 'set_status', ids: [1] });
    expect(missing.success).toBe(false);
    expect(missing.error?.flatten().fieldErrors).toHaveProperty('status');

    expect(schema.safeParse({ action: 'set_status', ids: [1], status: 'a' }).success).toBe(true);

    const stray = schema.safeParse({ action: 'delete', ids: [1], status: 'a' });
    expect(stray.success).toBe(false);
    expect(stray.error?.flatten().fieldErrors).toHaveProperty('status');
  });
});

describe('runBulk', () => {
  it('splits done from refused, in request order, and one refusal does not stop the rest', async () => {
    const seen: number[] = [];
    const result = await runBulk([5, 6, 7, 8], 'en', async (id) => {
      seen.push(id);
      if (id === 6) throw new BusinessError(409, 'has history', 'branch_has_history');
      if (id === 8) throw new NotFoundError('Branch not found');
    });

    expect(seen).toEqual([5, 6, 7, 8]);
    expect(result.done).toEqual([5, 7]);
    expect(result.refused.map((r) => [r.id, r.message_key])).toEqual([
      [6, 'branch_has_history'],
      [8, BULK_NOT_FOUND_KEY],
    ]);
  });

  it('translates each refusal for the request language, not the English fallback', async () => {
    const fail = async (): Promise<void> => {
      throw new BusinessError(409, 'English fallback', 'branch_has_history');
    };
    const [ar] = (await runBulk([1], 'ar', fail)).refused;
    const [en] = (await runBulk([1], 'en', fail)).refused;

    expect(ar?.message).not.toBe('English fallback');
    expect(en?.message).not.toBe('English fallback');
    expect(ar?.message).not.toBe(en?.message);
  });

  it('records an unexpected error as a refusal instead of hiding the rows already done', async () => {
    const result = await runBulk([1, 2, 3], 'en', async (id) => {
      if (id === 2) throw new Error('constraint nobody guarded');
    });

    expect(result.done).toEqual([1, 3]);
    expect(result.refused).toEqual([
      { id: 2, message_key: BULK_FAILED_KEY, message: expect.any(String) },
    ]);
  });

  it('runs sequentially — never two calls in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await runBulk([1, 2, 3, 4], 'en', async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBe(1);
  });
});
