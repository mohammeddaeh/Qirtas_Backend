import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { ApiError } from '../../../core/http/api-error.js';

/**
 * `POST /catalog/brands/bulk`, run through the REAL route stack (guard →
 * validate → archive guard → controller → service) with only the repositories
 * and the database faked.
 *
 * Wiring fails quietly: a missing `records.archive` check still answers 200
 * (with brands archived by someone who may not archive), and a service that
 * stopped calling `deleteBrand` still answers 200 (with a brand products carry
 * deleted from under them). So every pass sits beside its refusal, and the
 * refusal keys are the single endpoints' own.
 */

const held = { keys: [] as string[] };

vi.mock('../../identity/repositories/user-role-assignments.repository.js', () => ({
  findAllEffectivePermissionKeys: vi.fn(async () => held.keys),
}));

vi.mock('../../../core/db/client.js', () => ({
  pool: {},
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));

vi.mock('../../../core/audit/audit-recorder.js', () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock('../../../core/media/media.service.js', () => ({
  publicImagesByIds: vi.fn(async () => new Map()),
  attachPublicImages: vi.fn(async () => undefined),
}));

const now = new Date();
const archivedWrites: Array<[number, Date | null]> = [];
const deleted: number[] = [];

/** 1 plain · 2 archived · 3 missing · 4 carried by products */
function brandRow(id: number) {
  return {
    id,
    name: `B${id}`,
    name_normalized: `b${id}`,
    logo_image_id: null,
    archived_at: id === 2 ? now : null,
    created_at: now,
    updated_at: now,
  };
}

vi.mock('../repositories/brands.repository.js', () => ({
  findById: vi.fn(async (id: number) => (id === 3 ? undefined : brandRow(id))),
  update: vi.fn(async (id: number, fields: { archived_at: Date | null }) => {
    archivedWrites.push([id, fields.archived_at]);
    return { ...brandRow(id), ...fields };
  }),
  hardDelete: vi.fn(async (id: number) => {
    deleted.push(id);
  }),
}));

vi.mock('../repositories/products.repository.js', () => ({
  countProductsOfBrand: vi.fn(async (id: number) => (id === 4 ? 5 : 0)),
}));

const { catalogRouter } = await import('../routes/catalog.routes.js');

interface Outcome {
  status: number;
  body?: unknown;
  error?: ApiError;
}

type Data = {
  done: number[];
  refused: Array<{ id: number; message_key: string; message: string }>;
};

/** Runs every handler mounted on `POST /brands/bulk`, in order, like Express would. */
async function post(body: unknown): Promise<Outcome> {
  const layer = (
    catalogRouter.stack as unknown as Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{
          handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown;
        }>;
      };
    }>
  ).find((l) => l.route?.path === '/brands/bulk' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /brands/bulk is not mounted');

  const req = {
    body,
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

const dataOf = (out: Outcome) => (out.body as { data: Data }).data;

beforeEach(() => {
  held.keys = ['catalog.delete', 'records.archive'];
  archivedWrites.length = 0;
  deleted.length = 0;
});

describe('POST /catalog/brands/bulk', () => {
  it('delete: refuses a brand products carry and an unknown id, deletes the rest', async () => {
    const out = await post({ action: 'delete', ids: [1, 3, 4, 1] });
    expect(out.status).toBe(200);
    const data = dataOf(out);
    expect(data.done).toEqual([1]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([
      [3, 'record_not_found'],
      [4, 'brand_in_use'],
    ]);
    expect(data.refused.every((r) => r.message.length > 0)).toBe(true);
    // Duplicates dropped: brand 1 deleted once, the carried brand never.
    expect(deleted).toEqual([1]);
  });

  it('archive: writes the live brand, no-ops the archived one, refuses the unknown id', async () => {
    const out = await post({ action: 'archive', ids: [1, 2, 3] });
    expect(out.status).toBe(200);
    const data = dataOf(out);
    // Archiving an already-archived brand is a success without a write, as one-by-one.
    expect(data.done).toEqual([1, 2]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([[3, 'record_not_found']]);
    expect(archivedWrites.map(([id, at]) => [id, at instanceof Date])).toEqual([[1, true]]);
  });

  it('unarchive: restores the archived brand and writes null', async () => {
    const out = await post({ action: 'unarchive', ids: [2] });
    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([2]);
    expect(archivedWrites).toEqual([[2, null]]);
  });

  it('422 for an action the brand list does not offer, and for stray fields', async () => {
    const rename = await post({ action: 'rename', ids: [1] });
    expect(rename.status).toBe(422);

    const stray = await post({ action: 'delete', ids: [1], name: 'X' });
    expect(stray.status).toBe(422);
    expect(deleted).toEqual([]);
  });

  it('422 for more than 100 ids, and for none', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await post({ action: 'delete', ids })).status).toBe(422);
    expect((await post({ action: 'delete', ids: [] })).status).toBe(422);
    expect(deleted).toEqual([]);
  });

  it('refuses archive without records.archive for the whole request — and touches nothing', async () => {
    held.keys = ['catalog.delete'];
    const out = await post({ action: 'archive', ids: [1] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
    expect(archivedWrites).toEqual([]);
  });

  it('delete needs catalog.delete only — records.archive is not asked for it', async () => {
    held.keys = ['catalog.delete'];
    const out = await post({ action: 'delete', ids: [1] });
    expect(out.status).toBe(200);
    expect(deleted).toEqual([1]);
  });

  it('refuses every action without catalog.delete (catalog.edit + records.archive is not enough)', async () => {
    held.keys = ['catalog.edit', 'records.archive'];
    for (const action of ['delete', 'archive', 'unarchive']) {
      const out = await post({ action, ids: [1] });
      expect(out.status).toBe(403);
      expect(out.error?.messageKey).toBe('permission_missing');
    }
    expect(deleted).toEqual([]);
    expect(archivedWrites).toEqual([]);
  });
});
