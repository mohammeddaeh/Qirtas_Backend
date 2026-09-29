import { describe, expect, it } from 'vitest';
import {
  labelFitProblem,
  labelLayoutSchema,
  receiptLayoutSchema,
  type LabelPage,
} from '../dtos/layout.schema.js';

/**
 * A layout that is wrong does not fail anywhere: the receipt prints, the
 * sticker sheet prints — with its last row on a second page, or a block the
 * app does not know how to draw silently missing. So every rule is pinned
 * here **beside its opposite**: "a full grid fits" also passes for a check
 * that accepts everything.
 */

const labelPage = (medium: unknown, width = 70, height = 37): unknown => ({
  width_mm: width,
  height_mm: height,
  medium,
});

describe('receipt layout', () => {
  it('fills every default, so a device never reads a missing option', () => {
    const parsed = receiptLayoutSchema.parse({ page: { paper: 'roll_80' }, blocks: [{ type: 'totals' }] });
    expect(parsed.version).toBe(1);
    expect(parsed.page).toEqual({ paper: 'roll_80', margin_mm: 2, font_scale: 1, language: 'ar', copies: 1 });
    expect(parsed.blocks[0]).toEqual({
      type: 'totals',
      visible: true,
      show_subtotal: true,
      show_discount: true,
      show_tax: true,
      total_size: 'large',
    });
  });

  it('keeps what was sent over the default', () => {
    const parsed = receiptLayoutSchema.parse({
      page: { paper: 'roll_58', copies: 2 },
      blocks: [{ type: 'totals', visible: false, show_tax: false }],
    });
    expect(parsed.page.copies).toBe(2);
    expect(parsed.blocks[0]).toMatchObject({ visible: false, show_tax: false, show_discount: true });
  });

  it('refuses a label block on a receipt — and accepts the receipt one of the same idea', () => {
    expect(receiptLayoutSchema.safeParse({ page: { paper: 'a4' }, blocks: [{ type: 'price' }] }).success).toBe(false);
    expect(receiptLayoutSchema.safeParse({ page: { paper: 'a4' }, blocks: [{ type: 'totals' }] }).success).toBe(true);
  });

  it('refuses an option a block does not have (a typo is not stored silently)', () => {
    expect(
      receiptLayoutSchema.safeParse({ page: { paper: 'a4' }, blocks: [{ type: 'totals', show_taxx: true }] })
        .success,
    ).toBe(false);
  });

  it('refuses a single-use block twice — but a divider may repeat', () => {
    const twice = receiptLayoutSchema.safeParse({
      page: { paper: 'a4' },
      blocks: [{ type: 'totals' }, { type: 'totals' }],
    });
    expect(twice.success).toBe(false);
    if (!twice.success) expect(twice.error.issues[0]?.path).toEqual(['blocks', 1, 'type']);

    expect(
      receiptLayoutSchema.safeParse({ page: { paper: 'a4' }, blocks: [{ type: 'divider' }, { type: 'divider' }] })
        .success,
    ).toBe(true);
  });

  it('refuses an empty receipt, and an unknown paper', () => {
    expect(receiptLayoutSchema.safeParse({ page: { paper: 'a4' }, blocks: [] }).success).toBe(false);
    expect(receiptLayoutSchema.safeParse({ page: { paper: 'roll_100' }, blocks: [{ type: 'totals' }] }).success).toBe(
      false,
    );
  });
});

describe('label fit', () => {
  const page = (medium: LabelPage['medium'], width = 70, height = 37): LabelPage => ({
    width_mm: width,
    height_mm: height,
    margin_mm: 1,
    font_scale: 1,
    language: 'ar',
    medium,
  });
  const sheet = (over: Partial<Extract<LabelPage['medium'], { mode: 'sheet' }>>): LabelPage['medium'] => ({
    mode: 'sheet',
    sheet: 'a4',
    sheet_width_mm: null,
    sheet_height_mm: null,
    columns: 3,
    rows: 8,
    margin_top_mm: 0,
    margin_side_mm: 0,
    gap_x_mm: 0,
    gap_y_mm: 0,
    ...over,
  });

  it('a 3×8 grid of 70×37 fills an A4 exactly — and one more row does not fit', () => {
    expect(labelFitProblem(page(sheet({})))).toBeNull();
    expect(labelFitProblem(page(sheet({ rows: 9 })))).toMatch(/rows/);
  });

  it('gaps and margins count — the same grid with a gap overflows the width', () => {
    expect(labelFitProblem(page(sheet({ gap_x_mm: 2 })))).toMatch(/columns/);
    expect(labelFitProblem(page(sheet({ columns: 2, gap_x_mm: 2, margin_side_mm: 5 })))).toBeNull();
  });

  it('a custom sheet needs its size, and fits by it', () => {
    expect(labelFitProblem(page(sheet({ sheet: 'custom' })))).toMatch(/custom/);
    expect(
      labelFitProblem(page(sheet({ sheet: 'custom', sheet_width_mm: 100, sheet_height_mm: 80, columns: 1, rows: 2 }))),
    ).toBeNull();
  });

  it('a label on a receipt roll must fit the printable width, not the paper width', () => {
    expect(labelFitProblem(page({ mode: 'receipt_roll', roll: 'roll_58', gap_mm: 3 }, 48, 30))).toBeNull();
    expect(labelFitProblem(page({ mode: 'receipt_roll', roll: 'roll_58', gap_mm: 3 }, 50, 30))).toMatch(/48/);
    expect(labelFitProblem(page({ mode: 'receipt_roll', roll: 'roll_80', gap_mm: 3 }, 50, 30))).toBeNull();
  });

  it('a label printer takes any size — its own driver knows the stock', () => {
    expect(labelFitProblem(page({ mode: 'label_roll' }, 150, 150))).toBeNull();
  });
});

describe('label layout', () => {
  it('reports an overflowing sheet on the medium, where the editor can point', () => {
    const result = labelLayoutSchema.safeParse({
      page: labelPage({ mode: 'sheet', sheet: 'a4', columns: 3, rows: 9 }),
      blocks: [{ type: 'price' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.path.join('.'))).toContain('page.medium');
  });

  it('accepts the same layout once it fits', () => {
    expect(
      labelLayoutSchema.safeParse({
        page: labelPage({ mode: 'sheet', sheet: 'a4', columns: 3, rows: 8 }),
        blocks: [{ type: 'price' }],
      }).success,
    ).toBe(true);
  });

  it('refuses a receipt block on a label — and the QR here reads a code, not a sale', () => {
    const base = { page: labelPage({ mode: 'label_roll' }, 50, 30) };
    expect(labelLayoutSchema.safeParse({ ...base, blocks: [{ type: 'totals' }] }).success).toBe(false);
    const qr = labelLayoutSchema.parse({ ...base, blocks: [{ type: 'qr' }] });
    expect(qr.blocks[0]).toMatchObject({ type: 'qr', content: 'barcode' });
  });

  it('barcode defaults to auto symbology, and refuses one we cannot print', () => {
    const base = { page: labelPage({ mode: 'label_roll' }, 50, 30) };
    expect(labelLayoutSchema.parse({ ...base, blocks: [{ type: 'barcode' }] }).blocks[0]).toMatchObject({
      symbology: 'auto',
    });
    expect(
      labelLayoutSchema.safeParse({ ...base, blocks: [{ type: 'barcode', symbology: 'pdf417' }] }).success,
    ).toBe(false);
  });
});
