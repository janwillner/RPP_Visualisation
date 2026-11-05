import { describe, expect, it } from "vitest";
import { ProductGroups, partitionProducts } from "../src/scene/product-groups";
import type { ProductDisplay, SceneProduct } from "../src/scene/scene-model";

/** A product as the scene gives it; only display, size and shape decide its group. */
function product(id: number, display: ProductDisplay = "normal", length = 0.12): SceneProduct {
  return {
    key: `p${id}`,
    productId: id,
    conveyorId: 1,
    display,
    state: "detected",
    transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    bottom: { origin: [0, 0, 0], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    size: { length, width: 0.08, height: 0.04 },
    shape: "box",
    cornerRadius: 0,
    raw: {} as SceneProduct["raw"],
  };
}

const many = (count: number, display: ProductDisplay = "normal") =>
  Array.from({ length: count }, (_, i) => product(i + 1, display));

describe("product groups", () => {
  it("groups products on the belt by look and solid, and leaves placeholders and carried products single", () => {
    const products = [product(1), product(2, "normal", 0.15), product(3), product(4, "missed"), product(5, "placeholder"), product(6, "atTcp")];

    const { members, single } = partitionProducts(products);
    expect([...members.values()].map((list) => list.map((p) => p.productId))).toEqual([[1, 3], [2], [4]]);
    expect([...single.keys()]).toEqual(["p5", "p6"]);
    expect(new ProductGroups().of(products).map((g) => g.sample.productId)).toEqual([1, 2, 4]);
  });

  it("gives a group room for its products as a power of two, at least 64", () => {
    const groups = new ProductGroups();
    expect(groups.of(many(3))[0]!.capacity).toBe(64);
    expect(groups.of(many(100))[0]!.capacity).toBe(128);
    expect(groups.of(many(4800))[0]!.capacity).toBe(8192);
  });

  it("never shrinks a group, so one going up and down around a power of two keeps its mesh", () => {
    const groups = new ProductGroups();
    const capacities = [128, 129, 128, 129, 20].map((n) => groups.of(many(n))[0]!.capacity);
    expect(capacities).toEqual([128, 256, 256, 256, 256]);
  });
});
