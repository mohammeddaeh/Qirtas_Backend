import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { ApiError } from '../../../core/http/api-error.js';

/**
 * `POST /promotions/bulk`, run through the REAL route stack (guard → validate →
 * controller → service) with only the repositories and the database faked.
 *
 * Wiring fails quietly: a missing `promotions.edit` guard still answers 200
 * (with rows deleted by someone who may only read prices), and a service that
 * stopped calling `archivePromotion`/`removePromotion` still answers 200 (with
 * no audit entry). So every pass sits beside its refusal.
 */

const held = { keys: [] as string[] };

vi.mock('../../identity/repositories/user-role-assignments.repository.js', () => ({
  findAllEffectivePermissionKeys: vi.fn(async () => held.keys),
}));

vi.mock('../../../core/db/client.js', () => ({
  pool: {},
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));

const audits: string[] = [];
vi.mock('../../../core/audit/audit-recorder.js', () => ({
  recordAudit: vi.fn(async (_actor: unknown, action: string) => {
    audits.push(action);
  }),
}));

const now = new Date();
const archivedAt = new Map<number, Date | null>();
const updates: Array<[number, Record<string, unknown>]> = [];
const deleted: number[] = [];

/** 1 live · 2 archived · 3 missing */
function promotionRow(id: number) {
  return {
    id,
    name_ar: `P${id}`,
    name_en: null,
    scope: 'all_branches',
    target_kind: 'product',
    variant_id: null,
    product_id: 100,
    category_id: null,
    brand_id: null,
    kind: 'percent',
    percent_value: '10',
    amount_syp: null,
    buy_qty: null,
    get_qty: null,
    get_percent: null,
    starts_at: null,
    ends_at: null,
    channel: 'both',
    segment: 'all',
    is_stackable: false,
    is_active: true,
    archived_at: archivedAt.has(id) ? archivedAt.get(id)! : id === 2 ? now : null,
    created_by: 1,
    created_at: now,
    updated_at: now,
  };
}

vi.mock('../repositories/promotions.repository.js', () => ({
  findPromotionById: vi.fn(async (id: number) => (id === 3 ? undefined : promotionRow(id))),
  updatePromotion: vi.fn(async (id: number, fields: Record<string, unknown>) => {
    updates.push([id, fields]);
    if ('archived_at' in fields) archivedAt.set(id, fields.archived_at as Date | null);
    return promotionRow(id);
  }),
  deletePromotion: vi.fn(async (id: number) => {
    deleted.push(id);
  }),
  findBranchLinks: vi.fn(async () => []),
  findTiers: vi.fn(async () => []),
  findTargetLabel: vi.fn(async () => 'Product'),
}));

const { promotionsRouter } = await import('../routes/promotions.routes.js');

interface Outcome {
  status: number;
  body?: unknown;
  error?: ApiError;
}

type Data = {
  done: number[];
  refused: Array<{ id: number; message_key: string; message: string }>;
};

/** Runs every handler mounted on `method path`, in order, like Express would. */
async function call(
  method: 'get' | 'post' | 'delete',
  path: string,
  body: unknown,
  params: Record<string, string> = {},
): Promise<Outcome> {
  const layer = (
    promotionsRouter.stack as unknown as Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{
          handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown;
        }>;
      };
    }>
  ).find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} is not mounted`);

  const req = {
    body,
    params,
    query: {},
    user: { id: 1, status: 'active' },
    lang: 'en',
    ip: '127.0.0.1',
    header: () => undefined,
  } as unknown as Request;

  for (const { handle } of layer.route.stack) {
    const step = await new Promise<Outcome | 'next'>((resolve, reject) => {
      let statusCode = 200;
      const res = {
        status(code: number) {
          statusCode = code;
          return res;
        },
        json(b: unknown) {
          resolve({ status: statusCode, body: b });
        },
      } as unknown as Response;
      const next = (err?: unknown): void => {
        if (err instanceof ApiError) resolve({ status: err.httpStatus, error: err });
        else if (err) reject(err);
        else resolve('next');
      };
      try {
        handle(req, res, next);
      } catch (err) {
        next(err);
      }
    });
    if (step !== 'next') return step;
  }
  throw new Error('No handler answered');
}

const post = (body: unknown) => call('post', '/bulk', body);

const dataOf = (out: Outcome) => (out.body as { data: Data }).data;

beforeEach(() => {
  held.keys = ['promotions.edit'];
  archivedAt.clear();
  updates.length = 0;
  deleted.length = 0;
  audits.length = 0;
});

describe('POST /promotions/bulk', () => {
  it('archive: archives known rows, refuses the unknown one, audits each like POST /:id/archive', async () => {
    const out = await post({ action: 'archive', ids: [1, 3, 2] });
    expect(out.status).toBe(200);
    const data = dataOf(out);
    // Archiving an already-archived promotion is a no-op success, as one-by-one.
    expect(data.done).toEqual([1, 2]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([[3, 'record_not_found']]);
    expect(data.refused[0]!.message.length).toBeGreaterThan(0);
    // …and a no-op: the archived row keeps its date and gains no second audit entry.
    expect(updates.map(([id, f]) => [id, f.archived_at instanceof Date])).toEqual([[1, true]]);
    expect(audits).toEqual(['promotions.archive']);
  });

  it('unarchive writes archived_at: null through the same service call', async () => {
    const out = await post({ action: 'unarchive', ids: [2] });
    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([2]);
    expect(updates).toEqual([[2, { archived_at: null }]]);
    expect(audits).toEqual(['promotions.unarchive']);
  });

  it('unarchive of a live promotion is a no-op success — no write, no audit', async () => {
    const out = await post({ action: 'unarchive', ids: [1] });
    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([1]);
    expect(updates).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('delete: deletes deletable rows once each (duplicates dropped), refuses the unknown and the archived', async () => {
    const out = await post({ action: 'delete', ids: [1, 3, 1, 2] });
    expect(out.status).toBe(200);
    const data = dataOf(out);
    expect(data.done).toEqual([1]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([
      [3, 'record_not_found'],
      [2, 'promotion_not_deletable'],
    ]);
    expect(deleted).toEqual([1]);
    expect(audits).toEqual(['promotions.delete']);
  });

  it('403 without promotions.edit (promotions.view is not enough) — and touches nothing', async () => {
    held.keys = ['promotions.view'];
    for (const action of ['archive', 'unarchive', 'delete']) {
      const out = await post({ action, ids: [1] });
      expect(out.status).toBe(403);
      expect(out.error?.messageKey).toBe('permission_missing');
    }
    expect(updates).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('422 for an action the single routes do not offer, a stray field, or more than 100 ids', async () => {
    // Enabling/disabling is an edit (PUT /:id with every field), not a row action.
    expect((await post({ action: 'set_active', ids: [1] })).status).toBe(422);
    expect((await post({ action: 'archive', ids: [1], archived: true })).status).toBe(422);
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await post({ action: 'delete', ids })).status).toBe(422);
    expect(deleted).toEqual([]);
    expect(updates).toEqual([]);
  });
});

/**
 * The verdict the screen reads (`is_deletable`) and the refusal `DELETE /:id`
 * applies are one rule. Two copies drift silently: a button the server refuses,
 * or a delete that goes through on a row the screen said stays.
 */
describe('DELETE /promotions/:id follows the served is_deletable', () => {
  beforeEach(() => {
    held.keys = ['promotions.view', 'promotions.edit'];
  });

  it('the archived row reads is_deletable: false — and DELETE refuses it 409 without touching it', async () => {
    const detail = await call('get', '/:id', undefined, { id: '2' });
    expect(detail.status).toBe(200);
    expect((detail.body as { data: { is_deletable: boolean } }).data.is_deletable).toBe(false);

    const out = await call('delete', '/:id', undefined, { id: '2' });
    expect(out.status).toBe(409);
    expect(out.error?.messageKey).toBe('promotion_not_deletable');
    expect(deleted).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('the live row reads is_deletable: true — and DELETE removes it with one audit entry', async () => {
    const detail = await call('get', '/:id', undefined, { id: '1' });
    expect((detail.body as { data: { is_deletable: boolean } }).data.is_deletable).toBe(true);

    const out = await call('delete', '/:id', undefined, { id: '1' });
    expect(out.status).toBeLessThan(300);
    expect(deleted).toEqual([1]);
    expect(audits).toEqual(['promotions.delete']);
  });
});
