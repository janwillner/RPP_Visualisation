import { describe, expect, it } from "vitest";
import { PressTracker, isTap, nearestOnScreen, pickOnScreen, snapRadiusPx, type PointerSample } from "../src/scene/picking";

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

describe("picking a snap point on screen", () => {
  // A view looking down: renderer X to screen x, renderer Z to screen y, depth from Y; behind the camera above Y 10.
  const project = (p: readonly [number, number, number]) =>
    p[1] > 10 ? undefined : { screen: { x: p[0] * 100, y: p[2] * 100 }, depth: 10 - p[1] };
  const at = (label: string, position: [number, number, number]) => ({ label, position });

  it("projects every point and picks the nearest within the pointer's radius, nearer the camera on one spot", () => {
    const points = [at("far", [2, 0, 1]), at("low", [1, 0, 1]), at("high", [1, 0.5, 1]), at("behind", [1, 11, 1])];

    expect(pickOnScreen(points, { x: 101, y: 100 }, "mouse", project)?.label).toBe("high");
    expect(pickOnScreen(points, { x: 130, y: 100 }, "mouse", project)).toBeUndefined();
    expect(pickOnScreen(points, { x: 130, y: 100 }, "touch", project)?.label).toBe("high");
  });
});

describe("presses: which are taps", () => {
  const pointer = (pointerId: number, x: number, y = 0, pointerType = "touch", button = 0): PointerSample => ({
    pointerId,
    pointerType,
    x,
    y,
    button,
  });

  it("gives a tap where a press ends within the tolerance, and nothing for a camera drag", () => {
    const presses = new PressTracker();
    presses.pointerDown(pointer(1, 100, 100, "mouse"));
    expect(presses.pointerUp(pointer(1, 102, 100, "mouse"))).toEqual({ x: 102, y: 100 });
    expect(presses.lastWasTap).toBe(true);

    presses.pointerDown(pointer(1, 100, 100, "mouse"));
    expect(presses.pointerUp(pointer(1, 160, 100, "mouse"))).toBeUndefined();
    expect(presses.lastWasTap).toBe(false);
  });

  it("counts a pinch as no tap, also when its fingers come up one by one", () => {
    const presses = new PressTracker();
    presses.pointerDown(pointer(1, 100));
    presses.pointerDown(pointer(2, 200));
    expect(presses.pointers).toBe(2);

    expect(presses.pointerUp(pointer(2, 200))).toBeUndefined();
    expect(presses.pointerUp(pointer(1, 100))).toBeUndefined();
    expect(presses.lastWasTap).toBe(false);
    expect(presses.pointers).toBe(0);
  });

  it("counts a press as no tap once the browser cancels one of its pointers", () => {
    const presses = new PressTracker();
    presses.pointerDown(pointer(1, 100));
    presses.pointerCancel(1);
    expect(presses.lastWasTap).toBe(false);

    presses.pointerDown(pointer(2, 100));
    presses.pointerDown(pointer(3, 300));
    presses.pointerCancel(3);
    expect(presses.pointerUp(pointer(2, 100))).toBeUndefined();
  });

  it("lets a finger slide to adjust its choice where asked, but not a mouse", () => {
    const presses = new PressTracker({ touchSlides: true });
    presses.pointerDown(pointer(1, 100));
    expect(presses.pointerUp(pointer(1, 180))).toEqual({ x: 180, y: 0 });

    presses.pointerDown(pointer(2, 100, 0, "mouse"));
    expect(presses.pointerUp(pointer(2, 180, 0, "mouse"))).toBeUndefined();
  });

  it("ignores a release it saw no press for, and a secondary button where only the primary one counts", () => {
    const presses = new PressTracker({ primaryOnly: true });
    expect(presses.pointerUp(pointer(9, 100))).toBeUndefined();
    expect(presses.lastWasTap).toBe(true);

    presses.pointerDown(pointer(1, 100, 0, "mouse", 2));
    expect(presses.pointerUp(pointer(1, 100, 0, "mouse", 2))).toBeUndefined();
  });

  it("starts afresh when a pointer comes down again whose release went elsewhere, e.g. off the canvas", () => {
    const presses = new PressTracker();
    presses.pointerDown(pointer(1, 100, 0, "mouse"));
    // No pointerup for it.
    presses.pointerDown(pointer(1, 300, 0, "mouse"));
    expect(presses.pointers).toBe(1);
    expect(presses.pointerUp(pointer(1, 301, 0, "mouse"))).toEqual({ x: 301, y: 0 });
  });
});
