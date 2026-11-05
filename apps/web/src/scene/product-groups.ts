import type { ProductDisplay, SceneProduct } from "./scene-model";

/**
 * How products are batched for drawing. Products on a belt (normal or missed) are many: they are drawn per group of
 * the same look and solid as one instanced mesh. Placeholders and carried products are few and drawn one by one.
 */

/** Displays drawn in groups. */
const GROUPED: ReadonlySet<ProductDisplay> = new Set<ProductDisplay>(["normal", "missed"]);

/** Instances a group starts with. */
const MIN_CAPACITY = 64;

/** Products that share one instanced mesh: the same look and the same solid (shape and size). */
export interface ProductGroup {
  key: string;
  /** Any of its products, for the solid and the look. */
  sample: SceneProduct;
  /** Instances allocated: a power of two that only grows, so a register growing by a few keeps the mesh. */
  capacity: number;
}

/** Whether a product is drawn as part of a group rather than on its own. */
export function isGrouped(p: SceneProduct): boolean {
  return GROUPED.has(p.display);
}

/** The group a grouped product falls into. */
export function groupKey(p: SceneProduct): string {
  const { length, width, height } = p.size;
  return `${p.display}|${p.shape}|${length}|${width}|${height}|${p.cornerRadius}`;
}

/** A frame's products split for drawing: per group key the grouped ones in order, by key the ones drawn singly. */
export function partitionProducts(products: readonly SceneProduct[]): {
  members: Map<string, SceneProduct[]>;
  single: Map<string, SceneProduct>;
} {
  const members = new Map<string, SceneProduct[]>();
  const single = new Map<string, SceneProduct>();
  for (const p of products) {
    if (!isGrouped(p)) {
      single.set(p.key, p);
      continue;
    }
    const key = groupKey(p);
    const list = members.get(key);
    if (list) list.push(p);
    else members.set(key, [p]);
  }
  return { members, single };
}

/**
 * The groups of one source's products over time. Each group's capacity only ever grows: a group whose size goes up
 * and down around a power of two keeps its mesh instead of rebuilding it.
 */
export class ProductGroups {
  private readonly capacities = new Map<string, number>();

  /** The groups `products` fall into, each with room for its products. */
  of(products: readonly SceneProduct[]): ProductGroup[] {
    const groups = new Map<string, { sample: SceneProduct; count: number }>();
    for (const p of products) {
      if (!isGrouped(p)) continue;
      const key = groupKey(p);
      const g = groups.get(key);
      if (g) g.count += 1;
      else groups.set(key, { sample: p, count: 1 });
    }
    return [...groups].map(([key, g]) => {
      const capacity = Math.max(this.capacities.get(key) ?? MIN_CAPACITY, 2 ** Math.ceil(Math.log2(g.count)));
      this.capacities.set(key, capacity);
      return { key, sample: g.sample, capacity };
    });
  }
}
