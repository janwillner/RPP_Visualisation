import { describe, expect, it } from "vitest";
import { isTap, nearestOnScreen, snapRadiusPx } from "../src/scene/picking";

describe("tap or drag", () => {
  it("counts a mouse press as a click only while the pointer stays within a few pixels", () => {
    expect(isTap({ x: 100, y: 100 }, { x: 103, y: 100 }, "mouse")).toBe(true);
    expect(isTap({ x: 100, y: 100 }, { x: 106, y: 100 }, "mouse")).toBe(false);
  });

  it("allows a finger more travel than a mouse before a press becomes a camera drag", () => {
    expect(isTap({ x: 100, y: 100 }, { x: 106, y: 106 }, "touch")).toBe(true);
    expect(isTap({ x: 100, y: 100 }, { x: 112, y: 100 }, "touch")).toBe(false);
  });

  it("treats an unknown pointer type like a mouse", () => {
    expect(isTap({ x: 0, y: 0 }, { x: 6, y: 0 }, "")).toBe(false);
  });
});

describe("nearest snap point on screen", () => {
  const near = { item: "near", screen: { x: 105, y: 100 }, depth: 5 };
  const far = { item: "far", screen: { x: 130, y: 100 }, depth: 5 };

  it("picks the candidate nearest to the pointer within the radius", () => {
    expect(nearestOnScreen([far, near], { x: 100, y: 100 }, 40)).toBe("near");
  });

  it("picks nothing when every candidate is outside the radius", () => {
    expect(nearestOnScreen([far], { x: 100, y: 100 }, 12)).toBeUndefined();
  });

  it("prefers the candidate nearer to the camera when two lie on the same screen spot", () => {
    const behind = { item: "behind", screen: { x: 100, y: 100 }, depth: 9 };
    const front = { item: "front", screen: { x: 100.2, y: 100 }, depth: 3 };
    expect(nearestOnScreen([behind, front], { x: 100, y: 100 }, 12)).toBe("front");
  });

  it("gives a finger a larger snap radius than a mouse", () => {
    const pointer = { x: 100, y: 100 };
    expect(nearestOnScreen([far], pointer, snapRadiusPx("mouse"))).toBeUndefined();
    expect(nearestOnScreen([far], pointer, snapRadiusPx("touch"))).toBe("far");
  });
});
