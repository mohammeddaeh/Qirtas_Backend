import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { ApiError } from '../../../core/http/api-error.js';

/**
 * `POST /users/bulk`, run through the REAL route stack (entry guard → validate
 * → per-action guards → controller → service) with only the repositories
 * faked.
 *
 * Same reasoning as `branches-bulk.test.ts`: wiring fails quietly. A missing
 * `users.status` check still answers 200 (with people suspended by someone who
 * may not suspend), and a service that stopped calling the single-record
 * function still answers 200 (with the root/self/last-holder rules unchecked).
 * So the refusals sit beside the pass, and the refusal keys are the single
 * endpoints' own keys.
 */

const held = { keys: [] as string[] };

vi.mock('../repositories/user-role-assignments.repository.js', () => ({
  findAllEffectivePermissionKeys: vi.fn(async () => held.keys),
  findActiveForUser: vi.fn(async () => []),
  countOpenForUser: vi.fn(async () => 0),
  countAssignmentsEverForUser: vi.fn(async () => 0),
}));

vi.mock('../repositories/ownerships.repository.js', () => ({
  countOpenForUser: vi.fn(async () => 0),
  countEverForUser: vi.fn(async () => 0),
}));

vi.mock('../repositories/audit-log-entries.repository.js', () => ({
  // 3 once signed in — it has a past, so it cannot be deleted.
  countByActor: vi.fn(async (id: number) => (id === 3 ? 5 : 0)),
}));

const deleted: number[] = [];
const updated: Array<[number, Record<string, unknown>]> = [];

/**
 * 1 the caller · 2 plain active · 3 has audit history · 4 missing ·
 * 5 root-protected · 6 archived (disabled)
 */
function rowFor(id: number) {
  return {
    id,
    first_name: `U${id}`,
    last_name: 'Test',
    email: `u${id}@test.local`,
    phone: '0933111222',
    image: null,
    address: null,
    is_admin: false,
    is_root_protected: id === 5,
    mfa_enabled: false,
    email_verified_at: new Date(),
    status: id === 6 ? 'disabled' : 'active',
    rejection_reason: null,
    requested_role_id: null,
    requested_branch_id: null,
    requested_ownership_percentage: null,
    submitted_at: new Date(),
    decided_at: null,
    decided_by_user_id: null,
    archived_at: id === 6 ? new Date() : null,
    created_at: new Date(),
  };
}

vi.mock('../repositories/users.repository.js', () => ({
  findById: vi.fn(async (id: number) => (id === 4 ? undefined : rowFor(id))),
  update: vi.fn(async (id: number, patch: Record<string, unknown>) => {
    updated.push([id, patch]);
    return { ...rowFor(id), ...patch };
  }),
  deleteById: vi.fn(async (id: number) => {
    deleted.push(id);
  }),
}));

vi.mock('../services/audit.service.js', () => ({ record: vi.fn(async () => undefined) }));

vi.mock('../../../core/notifications/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notify: vi.fn(),
}));

const { usersRouter } = await import('../routes/users.routes.js');

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
    usersRouter.stack as unknown as Array<{
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
  held.keys = ['users.status', 'users.delete', 'records.archive'];
  deleted.length = 0;
  updated.length = 0;
});

describe('POST /users/bulk', () => {
  it('deletes some rows and refuses the rest with the single endpoint keys', async () => {
    const out = await post({ action: 'delete', ids: [2, 3, 4, 5, 1] });

    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([2]);
    expect(refusals(out)).toEqual([
      [3, 'user_has_audit_history'],
      [4, 'record_not_found'],
      [5, 'user_root_protected'],
      [1, 'user_cannot_remove_self'],
    ]);
    expect(dataOf(out).refused.every((r) => r.message.length > 0)).toBe(true);
    // Only the deletable row reached the repository.
    expect(deleted).toEqual([2]);
  });

  it('suspends through the single path — root and archived accounts refused', async () => {
    const out = await post({ action: 'suspend', ids: [2, 5, 6] });

    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([2]);
    expect(refusals(out)).toEqual([
      [5, 'user_root_protected'],
      [6, 'user_archived'],
    ]);
    expect(updated).toEqual([[2, { status: 'suspended' }]]);
  });

  it('reactivate refuses an account that is already active', async () => {
    const out = await post({ action: 'reactivate', ids: [2] });
    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([]);
    expect(refusals(out)).toEqual([[2, 'user_status_not_reactivatable']]);
    expect(updated).toEqual([]);
  });

  it('archives and restores through the single path', async () => {
    const archived = await post({ action: 'archive', ids: [2, 1] });
    expect(dataOf(archived).done).toEqual([2]);
    expect(refusals(archived)).toEqual([[1, 'user_cannot_remove_self']]);

    const restored = await post({ action: 'unarchive', ids: [6] });
    expect(dataOf(restored).done).toEqual([6]);
  });

  it('refuses status actions without users.status for the whole request', async () => {
    held.keys = ['users.delete', 'records.archive'];
    const out = await post({ action: 'disable', ids: [2] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
    expect(updated).toEqual([]);
  });

  it('refuses removals without users.delete — and does not demand it for status', async () => {
    held.keys = ['users.status', 'records.archive'];
    const refused = await post({ action: 'delete', ids: [2] });
    expect(refused.status).toBe(403);
    expect(refused.error?.messageKey).toBe('permission_missing');
    expect(deleted).toEqual([]);

    const allowed = await post({ action: 'suspend', ids: [2] });
    expect(allowed.status).toBe(200);
  });

  it('refuses archive without records.archive, but not delete', async () => {
    held.keys = ['users.delete'];
    const archive = await post({ action: 'archive', ids: [2] });
    expect(archive.status).toBe(403);
    expect(archive.error?.messageKey).toBe('permission_missing');
    expect(updated).toEqual([]);

    const del = await post({ action: 'delete', ids: [2] });
    expect(del.status).toBe(200);
  });

  it('refuses everything without either users key', async () => {
    held.keys = ['records.archive'];
    const out = await post({ action: 'unarchive', ids: [6] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
  });

  it('422 for an unknown action, a stray field, and more than 100 ids', async () => {
    expect((await post({ action: 'approve', ids: [2] })).status).toBe(422);
    expect((await post({ action: 'suspend', ids: [2], status: 'suspended' })).status).toBe(422);
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await post({ action: 'delete', ids })).status).toBe(422);
    expect(deleted).toEqual([]);
  });
});
