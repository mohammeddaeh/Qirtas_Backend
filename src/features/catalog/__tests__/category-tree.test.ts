import { describe, expect, it } from 'vitest';
import {
  CategoryTree,
  effectiveAttributeTypeIds,
  placementProblem,
  type TreeNode,
} from '../services/category-tree.js';
import { normalizeArabic } from '../../../core/i18n/arabic-normalize.js';

/**
 * A wrong answer here saves happily and shows nothing: a fourth level renders
 * as a menu nobody can reach on a phone, a cycle hangs any walk up the tree,
 * and a broken inheritance prices a whole subtree under the wrong policy. Each
 * rule is pinned with its opposite.
 */

function node(id: number, parent_id: number | null, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    parent_id,
    product_kind: null,
    price_policy: null,
    pricing_currency: null,
    ...extra,
  };
}

//  1 أدوات الكتابة (retail, banded, SYP)
//  └ 2 أقلام حبر
//    └ 3 جاف (USD)
//  4 الدفاتر
//  5 مواد الإنتاج (raw_material)
//  └ 6 ورق الإنتاج
const rows = [
  node(1, null, { product_kind: 'retail', price_policy: 'branch_banded', pricing_currency: 'SYP' }),
  node(2, 1),
  node(3, 2, { pricing_currency: 'USD' }),
  node(4, null),
  node(5, null, { product_kind: 'raw_material' }),
  node(6, 5),
];
const tree = new CategoryTree(rows);

describe('inheritance', () => {
  it('walks up to the first value set', () => {
    expect(tree.effective(3, 'price_policy')).toBe('branch_banded');
    expect(tree.effective(3, 'product_kind')).toBe('retail');
  });

  it('prefers the node over its ancestors', () => {
    expect(tree.effective(3, 'pricing_currency')).toBe('USD');
    expect(tree.effective(2, 'pricing_currency')).toBe('SYP');
  });

  it('answers null when nothing up the chain is set — not a default', () => {
    expect(tree.effective(4, 'price_policy')).toBeNull();
  });

  it('does not leak between siblings', () => {
    expect(tree.effective(6, 'product_kind')).toBe('raw_material');
    expect(tree.effective(4, 'product_kind')).toBeNull();
  });
});

describe('placement', () => {
  it('allows a third level', () => {
    expect(placementProblem(tree, null, 2)).toBeNull();
  });

  it('refuses a fourth level', () => {
    expect(placementProblem(tree, null, 3)).toBe('too_deep');
  });

  it('counts the subtree that moves with the node', () => {
    // «أقلام حبر» (2) carries «جاف» (3) under it: under root 4 it becomes level 2 + 1 below = 3 — fine.
    expect(placementProblem(tree, 2, 4)).toBeNull();
    // Under level-2 «ورق الإنتاج» (6) it would be level 3 with a child at 4 — refused.
    expect(placementProblem(tree, 2, 6)).toBe('too_deep');
  });

  it('refuses a node under itself or its own descendant', () => {
    expect(placementProblem(tree, 1, 1)).toBe('parent_is_self_or_descendant');
    expect(placementProblem(tree, 1, 3)).toBe('parent_is_self_or_descendant');
  });

  it('allows moving to the root', () => {
    expect(placementProblem(tree, 3, null)).toBeNull();
  });

  it('names a missing parent', () => {
    expect(placementProblem(tree, null, 99)).toBe('parent_not_found');
  });

  it('survives a cycle already in the data instead of looping', () => {
    const broken = new CategoryTree([node(1, 2), node(2, 1)]);
    expect(broken.ancestorsOf(1).map((n) => n.id)).toEqual([2]);
  });
});

describe('allowed attributes', () => {
  const own = new Map<number, number[]>([
    [1, [10, 11]],
    [3, [12, 10]],
  ]);

  it('adds every ancestor, without repeating what the node already has', () => {
    expect(effectiveAttributeTypeIds(tree, 3, own)).toEqual({ own: [12, 10], inherited: [11] });
  });

  it('gives a sibling subtree nothing', () => {
    expect(effectiveAttributeTypeIds(tree, 6, own)).toEqual({ own: [], inherited: [] });
  });
});

describe('normalizeArabic', () => {
  it.each([
    ['أقلام', 'اقلام'],
    ['مسطرة', 'مسطره'],
    ['مقوّى', 'مقوي'],
    ['إكسسوارات', 'اكسسوارات'],
    ['دفـــاتر', 'دفاتر'],
    ['  Faber-Castell ', 'faber-castell'],
    ['A٤', 'a4'],
  ])('folds %j and %j together', (a, b) => {
    expect(normalizeArabic(a)).toBe(normalizeArabic(b));
  });

  it('keeps different words apart', () => {
    expect(normalizeArabic('أقلام')).not.toBe(normalizeArabic('أفلام'));
    expect(normalizeArabic('دفتر')).not.toBe(normalizeArabic('دفاتر'));
  });
});
