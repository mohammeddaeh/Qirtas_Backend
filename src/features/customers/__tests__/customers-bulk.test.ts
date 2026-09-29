import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { ApiError } from '../../../core/http/api-error.js';

/**
 * `POST /customers/bulk`, run through the REAL route stack (entry guard →
 * validate → per-action guards → controller → service) with only the
 * repositories, the notifier and the database faked.
 *
 * Wiring fails quietly: a missing `customers.manage` check still answers 200
 * (with customers suspended by someone who may only archive), and a service
 * that stopped calling the single-record functions still answers 200 (with
 * "delete needs disabled" unchecked). So every pass sits beside its refusal,
 * and the refusal keys are the single endpoints' own.
 */

const held = { keys: [] as string[] };

vi.mock('../../identity/repositories/user-role-assignments.repository.js', () => ({
  findAllEffectivePermissionKeys: vi.fn(async () => held.keys),
}));

vi.mock('../../../core/db/client.js', () => ({
  pool: {},
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));

vi.mock('../../identity/services/audit.service.js', () => ({
  record: vi.fn(async () => undefined),
}));

const notified: number[] = [];
vi.mock('../../../core/notifications/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notify: vi.fn((n: { accountId: number }) => {
    notified.push(n.accountId);
  }),
}));

type Status = 'active' | 'suspended' | 'disabled';
// 1 active · 2 disabled · 3 missing · 4 archived (and disabled, as archive forces)
const rows = new Map<number, { status: Status; archived_at: Date | null }>();
const removed: number[] = [];
const written: number[] = [];

function row(id: number) {
  const r = rows.get(id);
  if (!r) return undefined;
  return {
    id,
    first_name: `C${id}`,
    last_name: 'Test',
    email: `c${id}@qirtas.test`,
    phone: null,
    image: null,
    password_hash: 'x',
    status: r.status,
    customer_type: 'retail',
    wholesale_status: null,
    preferred_branch_id: null,
    preferred_language: null,
    email_verified_at: null,
    wholesale_requested_at: null,
    wholesale_decided_at: null,
    wholesale_decided_by_user_id: null,
    wholesale_rejection_reason: null,
    archived_at: r.archived_at,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

vi.mock('../repositories/customers.repository.js', () => ({
  findById: vi.fn(async (id: number) => row(id)),
  update: vi.fn(async (id: number, patch: { status?: Status; archived_at?: Date | null }) => {
    const r = rows.get(id);
    if (!r) return undefined;
    written.push(id);
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.archived_at !== undefined) r.archived_at = patch.archived_at;
    return row(id);
  }),
  remove: vi.fn(async (id: number) => {
    removed.push(id);
    rows.delete(id);
  }),
}));

const { customersRouter } = await import('../routes/customers.routes.js');

interface Outcome {
  status: number;
  body?: unknown;
  error?: ApiError;
}

interface BulkData {
  done: number[];
  refused: Array<{ id: number; message_key: string; message: string }>;
}

/** Runs every handler mounted on `POST /bulk`, in order, like Express would. */
async function post(body: unknown): Promise<Outcome> {
  const layer = (
    customersRouter.stack as unknown as Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{
          handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown;
        }>;
      };
    }>
  ).find((l) => l.route?.path === '/bulk' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /bulk is not mounted');

  const req = {
    body,
    user: { id: 1, status: 'active' },
    lang: 'en',
    ip: '127.0.0.1',
    header: () => undefined,
  } as unknown as Request;

  for (const { handle } of layer.route.stack) {
    const step = await new Promise<Outcome | 'next'>((resolve) => {
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
        else if (err) throw err;
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

const dataOf = (out: Outcome) => (out.body as { data: BulkData }).data;
const refusals = (out: Outcome) => dataOf(out).refused.map((r) => [r.id, r.message_key]);

beforeEach(() => {
  held.keys = ['customers.manage', 'records.archive'];
  rows.clear();
  rows.set(1, { status: 'active', archived_at: null });
  rows.set(2, { status: 'disabled', archived_at: null });
  rows.set(4, { status: 'disabled', archived_at: new Date() });
  removed.length = 0;
  written.length = 0;
  notified.length = 0;
});

describe('POST /customers/bulk', () => {
  it('deletes only the disabled row and refuses the rest with the single endpoint keys', async () => {
    const out = await post({ action: 'delete', ids: [1, 2, 3] });

    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([2]);
    expect(refusals(out)).toEqual([
      [1, 'customer_delete_requires_disabled'],
      [3, 'record_not_found'],
    ]);
    expect(dataOf(out).refused.every((r) => r.message.length > 0)).toBe(true);
    expect(removed).toEqual([2]);
  });

  it('suspends through the single path: archived refused, customer told once per row', async () => {
    const out = await post({ action: 'suspend', ids: [1, 4] });

    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([1]);
    expect(refusals(out)).toEqual([[4, 'customer_archived']]);
    expect(rows.get(1)?.status).toBe('suspended');
    expect(notified).toEqual([1]);
  });

  it('archives and forces disabled, as POST /:id/archive does', async () => {
    const out = await post({ action: 'archive', ids: [1] });
    expect(dataOf(out).done).toEqual([1]);
    expect(rows.get(1)?.archived_at).not.toBeNull();
    expect(rows.get(1)?.status).toBe('disabled');
  });

  it('refuses unarchive on a live row with customer_not_archived', async () => {
    const out = await post({ action: 'unarchive', ids: [4, 1] });
    expect(dataOf(out).done).toEqual([4]);
    expect(refusals(out)).toEqual([[1, 'customer_not_archived']]);
  });

  it('dedupes ids so a row is acted on once', async () => {
    const out = await post({ action: 'reactivate', ids: [2, 2, 2] });
    expect(dataOf(out).done).toEqual([2]);
    expect(written).toEqual([2]);
  });

  it('archive needs records.archive ALONE — like the single route', async () => {
    held.keys = ['records.archive'];
    const out = await post({ action: 'archive', ids: [1] });
    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([1]);
  });

  it('refuses a status change without customers.manage for the whole request — and touches nothing', async () => {
    held.keys = ['records.archive'];
    const out = await post({ action: 'suspend', ids: [1] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
    expect(written).toEqual([]);
  });

  it('refuses archive without records.archive for the whole request', async () => {
    held.keys = ['customers.manage'];
    const out = await post({ action: 'archive', ids: [1] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
    expect(written).toEqual([]);
  });

  it('does NOT demand records.archive for delete', async () => {
    held.keys = ['customers.manage'];
    const out = await post({ action: 'delete', ids: [2] });
    expect(out.status).toBe(200);
  });

  it('refuses everything with neither key', async () => {
    held.keys = ['customers.view'];
    const out = await post({ action: 'reactivate', ids: [2] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
  });

  it('422 for an action it does not offer (wholesale), a stray field, or more than 100 ids', async () => {
    expect((await post({ action: 'approve_wholesale', ids: [1] })).status).toBe(422);
    expect((await post({ action: 'suspend', ids: [1], reason: 'x' })).status).toBe(422);
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await post({ action: 'delete', ids })).status).toBe(422);
    expect(removed).toEqual([]);
  });
});
