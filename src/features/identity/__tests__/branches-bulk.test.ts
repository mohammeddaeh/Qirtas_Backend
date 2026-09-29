import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { ApiError } from '../../../core/http/api-error.js';

/**
 * `POST /branches/bulk`, run through the REAL route stack (guards → validate →
 * conditional guard → controller → service) with only the repositories faked.
 *
 * What this guards is wiring, and wiring fails quietly: a missing
 * `records.archive` check still answers 200 (with rows archived by someone who
 * may not archive), and a service that stopped calling the single-record
 * function still answers 200 (with rules nobody checks). So the refusals sit
 * beside the pass, and the refusal keys are the single endpoints' own keys.
 */

const held = { keys: [] as string[] };

vi.mock('../repositories/user-role-assignments.repository.js', () => ({
  findAllEffectivePermissionKeys: vi.fn(async () => held.keys),
  countAssignmentsEverForBranch: vi.fn(async (id: number) => (id === 2 ? 3 : 0)),
  countActiveForBranch: vi.fn(async () => 0),
}));

vi.mock('../repositories/ownerships.repository.js', () => ({
  countEverForBranch: vi.fn(async () => 0),
  countOpenForBranch: vi.fn(async () => 0),
}));

const deleted: number[] = [];

vi.mock('../repositories/branches.repository.js', () => ({
  // 1 deletable · 2 has history · 3 missing · 4 the default branch
  findById: vi.fn(async (id: number) =>
    id === 3
      ? undefined
      : {
          id,
          name: `B${id}`,
          address: null,
          contact_info: null,
          status: 'active',
          is_default: id === 4,
          archived_at: null,
          latitude: null,
          longitude: null,
          status_changed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
  ),
  deleteById: vi.fn(async (id: number) => {
    deleted.push(id);
  }),
}));

vi.mock('../services/audit.service.js', () => ({ record: vi.fn(async () => undefined) }));

const { branchesRouter } = await import('../routes/branches.routes.js');

interface Outcome {
  status: number;
  body?: unknown;
  error?: ApiError;
}

/** Runs every handler mounted on `POST /bulk`, in order, like Express would. */
async function post(body: unknown): Promise<Outcome> {
  const layer = (
    branchesRouter.stack as unknown as Array<{
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

beforeEach(() => {
  held.keys = ['branches.manage', 'records.archive'];
  deleted.length = 0;
});

describe('POST /branches/bulk', () => {
  it('applies to some rows and refuses the rest with the single endpoint keys', async () => {
    const out = await post({ action: 'delete', ids: [1, 2, 3, 4] });

    expect(out.status).toBe(200);
    const data = (
      out.body as {
        data: {
          done: number[];
          refused: Array<{ id: number; message_key: string; message: string }>;
        };
      }
    ).data;
    expect(data.done).toEqual([1]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([
      [2, 'branch_has_history'],
      [3, 'record_not_found'],
      [4, 'branch_is_default'],
    ]);
    expect(data.refused.every((r) => r.message.length > 0)).toBe(true);
    // Only the deletable row reached the repository.
    expect(deleted).toEqual([1]);
  });

  it('dedupes ids so a row is acted on once', async () => {
    const out = await post({ action: 'delete', ids: [1, 1, 1] });
    const data = (out.body as { data: { done: number[]; refused: unknown[] } }).data;
    expect(data.done).toEqual([1]);
    expect(data.refused).toEqual([]);
    expect(deleted).toEqual([1]);
  });

  it('refuses archive without records.archive for the whole request — and touches nothing', async () => {
    held.keys = ['branches.manage'];
    const out = await post({ action: 'archive', ids: [1, 2] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
  });

  it('does NOT demand records.archive for delete', async () => {
    held.keys = ['branches.manage'];
    const out = await post({ action: 'delete', ids: [1] });
    expect(out.status).toBe(200);
  });

  it('refuses everything without branches.manage', async () => {
    held.keys = ['records.archive'];
    const out = await post({ action: 'delete', ids: [1] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
  });

  it('422 for set_status without status, and for status on another action', async () => {
    const missing = await post({ action: 'set_status', ids: [1] });
    expect(missing.status).toBe(422);
    expect(missing.error?.details).toHaveProperty('status');

    const stray = await post({ action: 'delete', ids: [1], status: 'closed' });
    expect(stray.status).toBe(422);
  });

  it('422 for more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const out = await post({ action: 'delete', ids });
    expect(out.status).toBe(422);
    expect(deleted).toEqual([]);
  });
});
