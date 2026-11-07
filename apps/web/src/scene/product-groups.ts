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

/** A frame's products as they are drawn. */
export interface GroupedProducts {
  /** The groups, each with room for its products. */
  groups: ProductGroup[];
  /** Per group key its products, in order. */
  members: Map<string, SceneProduct[]>;
  /** The products drawn one by one, by key. */
  single: Map<string, SceneProduct>;
}

/**
 * The groups of one source's products over time. Each group's capacity only ever grows: a group whose size goes up
 * and down around a power of two keeps its mesh instead of rebuilding it.
 */
export class ProductGroups {
  private readonly capacities = new Map<string, number>();

  /** Sorts one frame's products into their groups, in one pass. */
  update(products: readonly SceneProduct[]): GroupedProducts {
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
    const groups = [...members].map(([key, list]) => {
      const capacity = Math.max(this.capacities.get(key) ?? MIN_CAPACITY, 2 ** Math.ceil(Math.log2(list.length)));
      this.capacities.set(key, capacity);
      return { key, sample: list[0]!, capacity };
    });
    return { groups, members, single };
  }
}
