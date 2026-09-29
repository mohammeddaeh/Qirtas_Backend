import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { ApiError } from '../../../core/http/api-error.js';

/**
 * `POST /roles/bulk`, run through the REAL route stack (guards → validate →
 * conditional guard → controller → service) with only the repositories faked.
 *
 * Same reasoning as `branches-bulk.test.ts`: what this guards is wiring, and
 * wiring fails quietly. A missing `records.archive` check still answers 200,
 * and a bulk path that stopped calling the single-record function still
 * answers 200 — with the Super Admin role deactivated. So each refusal sits
 * beside the pass, keyed exactly as the single endpoint keys it.
 */

const held = { keys: [] as string[] };

vi.mock('../repositories/user-role-assignments.repository.js', () => ({
  findAllEffectivePermissionKeys: vi.fn(async () => held.keys),
  findHighestAuthorityLevel: vi.fn(async () => 0),
  countOpenForRole: vi.fn(async (id: number) => (id === 2 ? 1 : 0)),
  countActiveHoldersOfRole: vi.fn(async () => 0),
}));

const deleted: number[] = [];
const activeSet: Array<[number, boolean]> = [];
const archivedSet: number[] = [];

// 1 plain, never assigned · 2 held (history + open assignment) · 3 missing ·
// 4 seeded default · 5 the Super Admin role
function roleRow(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    name: id === 5 ? 'المدير العام' : `R${id}`,
    category: 'operational',
    level: id === 5 ? 0 : null,
    is_system_default: id === 4 || id === 5,
    is_active: true,
    archived_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

vi.mock('../repositories/roles.repository.js', () => ({
  findById: vi.fn(async (id: number) => (id === 3 ? undefined : roleRow(id))),
  countAllAssignmentsEver: vi.fn(async (id: number) => (id === 2 ? 3 : 0)),
  hasActiveAssignments: vi.fn(async (id: number) => id === 2),
  findPermissionsByRole: vi.fn(async () => []),
  deleteById: vi.fn(async (id: number) => {
    deleted.push(id);
  }),
  setActive: vi.fn(async (id: number, active: boolean) => {
    activeSet.push([id, active]);
    return roleRow(id, { is_active: active });
  }),
  setArchivedAt: vi.fn(async (id: number, at: Date | null) => {
    archivedSet.push(id);
    return roleRow(id, { archived_at: at });
  }),
}));

vi.mock('../services/audit.service.js', () => ({ record: vi.fn(async () => undefined) }));

const { rolesRouter } = await import('../routes/roles.routes.js');

interface Outcome {
  status: number;
  body?: unknown;
  error?: ApiError;
}

type BulkData = {
  done: number[];
  refused: Array<{ id: number; message_key: string; message: string }>;
};

/** Runs every handler mounted on `POST /bulk`, in order, like Express would. */
async function post(body: unknown): Promise<Outcome> {
  const layer = (
    rolesRouter.stack as unknown as Array<{
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

function dataOf(out: Outcome): BulkData {
  return (out.body as { data: BulkData }).data;
}

beforeEach(() => {
  held.keys = ['roles.edit', 'records.archive'];
  deleted.length = 0;
  activeSet.length = 0;
  archivedSet.length = 0;
});

describe('POST /roles/bulk', () => {
  it('deletes what may be deleted and refuses the rest with the single endpoint keys', async () => {
    const out = await post({ action: 'delete', ids: [1, 2, 3, 4] });

    expect(out.status).toBe(200);
    const data = dataOf(out);
    expect(data.done).toEqual([1]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([
      [2, 'role_has_history'],
      [3, 'record_not_found'],
      [4, 'role_system_default_undeletable'],
    ]);
    expect(data.refused.every((r) => r.message.length > 0)).toBe(true);
    expect(deleted).toEqual([1]);
  });

  it('never deactivates the Super Admin role — the service refusal, not a bulk special case', async () => {
    const out = await post({ action: 'deactivate', ids: [1, 2, 5] });

    expect(out.status).toBe(200);
    const data = dataOf(out);
    expect(data.done).toEqual([1]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([
      [2, 'role_has_active_assignments'],
      [5, 'super_admin_role_undeactivatable'],
    ]);
    expect(activeSet).toEqual([[1, false]]);
  });

  it('reactivate refuses a role that is already active, as the single route does', async () => {
    const out = await post({ action: 'reactivate', ids: [1] });
    expect(out.status).toBe(200);
    expect(dataOf(out).refused.map((r) => r.message_key)).toEqual(['role_already_active']);
    expect(activeSet).toEqual([]);
  });

  it('archives what nobody holds and refuses the held and the seeded', async () => {
    const out = await post({ action: 'archive', ids: [1, 2, 4] });
    expect(out.status).toBe(200);
    const data = dataOf(out);
    expect(data.done).toEqual([1]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([
      [2, 'role_has_active_holders'],
      [4, 'role_system_default_unarchivable'],
    ]);
    expect(archivedSet).toEqual([1]);
  });

  it('refuses archive without records.archive for the whole request — and touches nothing', async () => {
    held.keys = ['roles.edit'];
    const out = await post({ action: 'archive', ids: [1] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
    expect(archivedSet).toEqual([]);
  });

  it('does NOT demand records.archive for delete or deactivate', async () => {
    held.keys = ['roles.edit'];
    expect((await post({ action: 'delete', ids: [1] })).status).toBe(200);
    expect((await post({ action: 'deactivate', ids: [1] })).status).toBe(200);
  });

  it('refuses everything without roles.edit — roles.view is not enough', async () => {
    held.keys = ['roles.view', 'records.archive'];
    const out = await post({ action: 'delete', ids: [1] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
    expect(deleted).toEqual([]);
  });

  it('422 for an unknown action, a stray field, or more than 100 ids', async () => {
    expect((await post({ action: 'rename', ids: [1] })).status).toBe(422);
    expect((await post({ action: 'delete', ids: [1], name: 'x' })).status).toBe(422);
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await post({ action: 'delete', ids })).status).toBe(422);
    expect(deleted).toEqual([]);
  });
});
