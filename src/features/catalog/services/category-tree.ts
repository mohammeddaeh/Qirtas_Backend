import type { PricePolicy, PricingCurrency, ProductKind } from '../schemas/catalog-enums.schema.js';

/**
 * The category tree's rules, as pure functions over rows already in memory.
 *
 * The whole tree is loaded for every structural decision. It is small (the
 * seed has ~100 categories; a large shop a few hundred), and deciding depth,
 * cycles and inheritance on the full picture is far simpler to get right than
 * recursive SQL — and trivially testable, which is the point of this file.
 */

export const MAX_CATEGORY_DEPTH = 3;

export interface TreeNode {
  id: number;
  parent_id: number | null;
  product_kind: ProductKind | null;
  price_policy: PricePolicy | null;
  pricing_currency: PricingCurrency | null;
}

export class CategoryTree<T extends TreeNode> {
  private readonly byId: Map<number, T>;
  private readonly children: Map<number | null, T[]>;

  constructor(rows: readonly T[]) {
    this.byId = new Map(rows.map((row) => [row.id, row]));
    this.children = new Map();
    for (const row of rows) {
      const list = this.children.get(row.parent_id) ?? [];
      list.push(row);
      this.children.set(row.parent_id, list);
    }
  }

  get(id: number): T | undefined {
    return this.byId.get(id);
  }

  childrenOf(id: number | null): readonly T[] {
    return this.children.get(id) ?? [];
  }

  /** Parent first, root last. Stops on a cycle rather than looping — the data is never trusted to be a tree. */
  ancestorsOf(id: number): T[] {
    const result: T[] = [];
    const seen = new Set<number>([id]);
    let current = this.byId.get(id)?.parent_id ?? null;
    while (current !== null && !seen.has(current)) {
      const node = this.byId.get(current);
      if (!node) break;
      result.push(node);
      seen.add(current);
      current = node.parent_id;
    }
    return result;
  }

  descendantIdsOf(id: number): Set<number> {
    const result = new Set<number>();
    const stack = [...this.childrenOf(id)];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (result.has(node.id)) continue;
      result.add(node.id);
      stack.push(...this.childrenOf(node.id));
    }
    return result;
  }

  /** Levels below this node: a leaf is 0, a node with children only is 1. */
  heightBelow(id: number): number {
    let height = 0;
    for (const child of this.childrenOf(id))
      height = Math.max(height, 1 + this.heightBelow(child.id));
    return height;
  }

  /** First non-null value walking up from the node itself. */
  effective<K extends 'product_kind' | 'price_policy' | 'pricing_currency'>(
    id: number,
    field: K,
  ): T[K] | null {
    const self = this.byId.get(id);
    if (!self) return null;
    if (self[field] !== null) return self[field];
    for (const ancestor of this.ancestorsOf(id))
      if (ancestor[field] !== null) return ancestor[field];
    return null;
  }

  /** The level a node gets under [parentId]: roots are 1. */
  levelUnder(parentId: number | null): number {
    if (parentId === null) return 1;
    return this.ancestorsOf(parentId).length + 2;
  }
}

export type PlacementProblem = 'parent_not_found' | 'parent_is_self_or_descendant' | 'too_deep';

/**
 * Can [nodeId] (or a new node, when `null`) sit under [parentId]?
 *
 * Moving a node moves its whole subtree, so depth is checked with the subtree
 * attached: «أقلام» with two levels beneath it cannot move under a level-2
 * parent, even though «أقلام» itself would only be level 3.
 */
export function placementProblem<T extends TreeNode>(
  tree: CategoryTree<T>,
  nodeId: number | null,
  parentId: number | null,
): PlacementProblem | null {
  if (parentId !== null) {
    if (!tree.get(parentId)) return 'parent_not_found';
    if (nodeId !== null && (parentId === nodeId || tree.descendantIdsOf(nodeId).has(parentId))) {
      return 'parent_is_self_or_descendant';
    }
  }
  const level = tree.levelUnder(parentId);
  const below = nodeId === null ? 0 : tree.heightBelow(nodeId);
  return level + below > MAX_CATEGORY_DEPTH ? 'too_deep' : null;
}

/** Attribute types a category's products may use: its own plus every ancestor's. */
export function effectiveAttributeTypeIds<T extends TreeNode>(
  tree: CategoryTree<T>,
  categoryId: number,
  ownByCategory: ReadonlyMap<number, readonly number[]>,
): { own: number[]; inherited: number[] } {
  const own = [...(ownByCategory.get(categoryId) ?? [])];
  const ownSet = new Set(own);
  const inherited: number[] = [];
  for (const ancestor of tree.ancestorsOf(categoryId)) {
    for (const typeId of ownByCategory.get(ancestor.id) ?? []) {
      if (!ownSet.has(typeId) && !inherited.includes(typeId)) inherited.push(typeId);
    }
  }
  return { own, inherited };
}
