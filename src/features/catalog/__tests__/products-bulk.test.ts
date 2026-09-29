import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { ApiError } from '../../../core/http/api-error.js';

/**
 * `POST /catalog/products/bulk`, run through the REAL route stack (entry guard
 * → validate → per-action guards → controller → service) with only the
 * repositories and the database faked.
 *
 * Wiring fails quietly: a missing `records.archive` check still answers 200
 * (with rows archived by someone who may not archive), and a service that
 * stopped calling `updateProduct` still answers 200 (with the category-fit
 * rule unchecked). So every pass sits beside its refusal, and the refusal keys
 * are the single endpoints' own.
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

vi.mock('../../../core/records/deletion-guards.js', () => ({
  // Product 2 has stock movements.
  countExternalReferences: vi.fn(async (_entity: string, ids: number[]) => (ids[0] === 2 ? 3 : 0)),
}));

vi.mock('../../../core/media/media.service.js', () => ({
  publicImagesByIds: vi.fn(async () => new Map()),
  attachPublicImages: vi.fn(async () => undefined),
}));

const now = new Date();
const category = (id: number, parent_id: number | null = null) => ({
  id,
  parent_id,
  name_ar: `C${id}`,
  name_en: null,
  archived_at: null,
  product_kind: null,
  price_policy: null,
  pricing_currency: null,
});

vi.mock('../repositories/categories.repository.js', () => ({
  // 10 allows attribute type 5 · 20 allows nothing · 30 has a child (not a leaf)
  findAll: vi.fn(async () => [category(10), category(20), category(30), category(31, 30)]),
  findAllAttributeLinks: vi.fn(async () => [{ category_id: 10, attribute_type_id: 5 }]),
}));

vi.mock('../repositories/attributes.repository.js', () => ({
  findAllTypes: vi.fn(async () => [
    { id: 5, name_ar: 'لون', name_en: null, sort_order: 0, archived_at: null },
  ]),
  findAllValues: vi.fn(async () => [
    { id: 500, attribute_type_id: 5, value_ar: 'أحمر', value_en: null, color_hex: null },
  ]),
}));

vi.mock('../repositories/units.repository.js', () => ({ findAll: vi.fn(async () => []) }));

vi.mock('../repositories/brands.repository.js', () => ({
  findById: vi.fn(async (id: number) =>
    id === 7 ? { id: 7, name: 'Faber', archived_at: null } : undefined,
  ),
}));

const updates: Array<[number, Record<string, unknown>]> = [];
const deleted: number[] = [];

/** 1 plain · 2 archived · 3 missing · 4 has a variant using attribute type 5 */
function productRow(id: number) {
  return {
    id,
    category_id: 10,
    brand_id: null,
    kind: 'retail',
    is_sellable: true,
    name_ar: `P${id}`,
    name_en: null,
    description_ar: null,
    description_en: null,
    search_keywords: [],
    price_policy: null,
    pricing_currency: null,
    status: 'active',
    archived_at: id === 2 ? now : null,
    created_at: now,
    updated_at: now,
  };
}

vi.mock('../repositories/products.repository.js', () => ({
  findById: vi.fn(async (id: number) => (id === 3 ? undefined : productRow(id))),
  findVariantsOfProducts: vi.fn(async (ids: number[]) =>
    ids.map((id) => ({
      id: id * 10,
      product_id: id,
      sku: null,
      status: 'active',
      sort_order: 0,
      base_unit_id: 1,
    })),
  ),
  findValuesOfVariants: vi.fn(async (variantIds: number[]) =>
    variantIds.includes(40)
      ? [{ variant_id: 40, attribute_type_id: 5, attribute_value_id: 500 }]
      : [],
  ),
  findUnitsOfVariants: vi.fn(async () => []),
  findMediaOfProducts: vi.fn(async () => []),
  findBarcodesOfUnits: vi.fn(async () => []),
  countByCodes: vi.fn(async () => new Map()),
  updateProduct: vi.fn(async (_tx: unknown, id: number, fields: Record<string, unknown>) => {
    updates.push([id, fields]);
    return { ...productRow(id), ...fields };
  }),
  replaceProductImages: vi.fn(async () => undefined),
  hardDeleteProduct: vi.fn(async (_tx: unknown, id: number) => {
    deleted.push(id);
  }),
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

/** Runs every handler mounted on `POST /products/bulk`, in order, like Express would. */
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
  ).find((l) => l.route?.path === '/products/bulk' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /products/bulk is not mounted');

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
  held.keys = ['catalog.edit', 'catalog.delete', 'records.archive'];
  updates.length = 0;
  deleted.length = 0;
});

describe('POST /catalog/products/bulk', () => {
  it('set_category: applies to some rows and refuses the rest with PATCH /products/:id keys', async () => {
    const out = await post({ action: 'set_category', ids: [1, 2, 3, 4], category_id: 20 });

    expect(out.status).toBe(200);
    const data = dataOf(out);
    expect(data.done).toEqual([1]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([
      [2, 'product_archived'],
      [3, 'record_not_found'],
      [4, 'product_attributes_not_allowed_in_category'],
    ]);
    expect(data.refused.every((r) => r.message.length > 0)).toBe(true);
    // Only the fitting row was written, and with that one field.
    expect(updates.map(([id, f]) => [id, f.category_id])).toEqual([[1, 20]]);
  });

  it('delete: refuses a product with movements and an unknown id, deletes the rest', async () => {
    const out = await post({ action: 'delete', ids: [1, 2, 3, 1] });
    expect(out.status).toBe(200);
    const data = dataOf(out);
    expect(data.done).toEqual([1]);
    expect(data.refused.map((r) => [r.id, r.message_key])).toEqual([
      [2, 'product_has_movements'],
      [3, 'record_not_found'],
    ]);
    expect(deleted).toEqual([1]);
  });

  it('set_brand accepts brand_id: null (remove the brand) and writes null', async () => {
    const out = await post({ action: 'set_brand', ids: [1], brand_id: null });
    expect(out.status).toBe(200);
    expect(dataOf(out).done).toEqual([1]);
    expect(updates).toEqual([[1, expect.objectContaining({ brand_id: null })]]);
  });

  it('422 for set_category without category_id, and for category_id on delete', async () => {
    const missing = await post({ action: 'set_category', ids: [1] });
    expect(missing.status).toBe(422);
    expect(missing.error?.details).toHaveProperty('category_id');

    const stray = await post({ action: 'delete', ids: [1], category_id: 20 });
    expect(stray.status).toBe(422);
    expect(stray.error?.details).toHaveProperty('category_id');
    expect(deleted).toEqual([]);
  });

  it('422 for set_brand without the brand_id key, and for draft as a bulk status', async () => {
    expect((await post({ action: 'set_brand', ids: [1] })).status).toBe(422);
    expect((await post({ action: 'set_status', ids: [1], status: 'draft' })).status).toBe(422);
  });

  it('422 for more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const out = await post({ action: 'delete', ids });
    expect(out.status).toBe(422);
    expect(deleted).toEqual([]);
  });

  it('refuses archive without records.archive for the whole request — and touches nothing', async () => {
    held.keys = ['catalog.edit', 'catalog.delete'];
    const out = await post({ action: 'archive', ids: [1] });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
    expect(updates).toEqual([]);
  });

  it('refuses set_sellable without catalog.edit (catalog.delete is not enough)', async () => {
    held.keys = ['catalog.delete', 'records.archive'];
    const out = await post({ action: 'set_sellable', ids: [1], is_sellable: false });
    expect(out.status).toBe(403);
    expect(out.error?.messageKey).toBe('permission_missing');
    expect(updates).toEqual([]);
  });

  it('delete needs catalog.delete, not catalog.edit', async () => {
    held.keys = ['catalog.edit'];
    const refused = await post({ action: 'delete', ids: [1] });
    expect(refused.status).toBe(403);
    expect(deleted).toEqual([]);

    held.keys = ['catalog.delete'];
    const allowed = await post({ action: 'delete', ids: [1] });
    expect(allowed.status).toBe(200);
    expect(deleted).toEqual([1]);
  });

  it('archive passes with catalog.delete + records.archive and no catalog.edit', async () => {
    held.keys = ['catalog.delete', 'records.archive'];
    const out = await post({ action: 'archive', ids: [1, 2] });
    expect(out.status).toBe(200);
    // Archiving an already-archived product is a no-op success, as one-by-one.
    expect(dataOf(out).done).toEqual([1, 2]);
  });
});
