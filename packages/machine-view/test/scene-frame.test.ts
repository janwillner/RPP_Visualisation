import { describe, expect, it } from "vitest";
import type { ConfigMessage, ConveyorConfig, DeltaConfig, Position, Product, StateMessage } from "@rpp/protocol";
import { MachineFrame, SourceFrame } from "../src/scene/scene-frame";
import { buildMachineScene, buildScene, componentKey, type SceneSource } from "../src/scene/scene-model";

const conveyor = (overrides: Partial<ConveyorConfig> = {}): ConveyorConfig => ({
  type: "conveyor",
  id: 1,
  sourceId: "plc1",
  name: "Infeed",
  pose: { x: 0, y: 0, z: 800, rx: 0, ry: 0, rz: 0 },
  length: 3000,
  width: 400,
  productTypes: [{ id: 1, length: 100, width: 80, height: 40, shape: "box", cornerRadius: 0 }],
  body: true,
  originShift: { x: 0, y: 0, z: 0 },
  ...overrides,
});

const delta: DeltaConfig = {
  type: "delta",
  id: 20,
  sourceId: "plc1",
  name: "Delta 1",
  pose: { x: 1500, y: 0, z: 1800, rx: 0, ry: 0, rz: 0 },
  baseRadius: 200,
  effectorRadius: 50,
  upperArmLength: 350,
  lowerArmLength: 800,
  workingArea: { radius: 600, zMin: -1100, zMax: -600, coneHeight: 0, coneBottomRadius: 0 },
  limitArea: null,
  tcpLimitArea: null,
  zones: [],
  fingers: [],
  originShift: { x: 0, y: 0, z: 0 },
};

const config = (...components: ConfigMessage["components"]): ConfigMessage => ({
  kind: "config",
  sourceId: "plc1",
  protocolVersion: 1,
  configVersion: 1,
  components,
  errors: [],
});

const product = (id: number, overrides: Partial<Product> = {}): Product => ({
  id,
  latchPose: { x: id * 40, y: 0, z: 0, rz: 0 },
  latchBeltPosition: 0,
  state: "detected",
  previousState: "detected",
  lastClientId: 0,
  moverId: 0,
  fingerId: 0,
  productType: 1,
  ...overrides,
});

/** A state of the conveyor (and the Delta, with `tcp`), `fault` on the conveyor. */
function state(beltPosition: number, products: Product[], tcp?: Position, fault: string | null = null): StateMessage {
  const components: StateMessage["components"] = [
    { type: "conveyor", id: 1, timestamp: "0", beltPosition, products, fault: fault === null ? null : { message: fault } },
  ];
  if (tcp) components.push({ type: "delta", id: 20, timestamp: "0", actualTcp: tcp, setpointTcp: tcp, fingers: [], fault: null });
  return { kind: "state", sourceId: "plc1", configVersion: 1, timestamp: "0", tRel: 0, components };
}

const TCP = { x: 1500, y: 0, z: 1000 };

/** Feeds the frame the scene of each state in turn; whether each was a structural change. */
function changes(frame: SourceFrame, c: ConfigMessage, ...states: StateMessage[]): boolean[] {
  return states.map((s) => frame.next(buildScene(c, [s], 0)));
}

describe("scene frame: when the 3D view re-renders", () => {
  it("re-renders for the first scene, not while only the belt or the TCP moves", () => {
    const c = config(conveyor(), delta);
    const products = [product(1), product(2)];

    expect(
      changes(new SourceFrame(), c, state(0, products, TCP), state(50, products, { ...TCP, x: 1600 }), state(90, products, TCP)),
    ).toEqual([true, false, false]);
  });

  it("re-renders for a new conveyor, a fault label, and a product group that outgrows its instances", () => {
    const frame = new SourceFrame();
    const few = [product(1)];
    const many = Array.from({ length: 65 }, (_, i) => product(i + 1));
    expect(frame.next(buildScene(config(conveyor()), [state(0, few)], 0))).toBe(true);

    expect(frame.next(buildScene(config(conveyor(), conveyor({ id: 2, name: "Outfeed" })), [state(0, few)], 0))).toBe(true);
    expect(changes(frame, config(conveyor()), state(0, few, undefined, "Jam"), state(0, few, undefined, "Jam"))).toEqual([true, false]);
    // The label goes again. A group starts with room for 64: a few more products of the same look need no new mesh,
    // and one that grew keeps its room when it shrinks.
    expect(
      changes(frame, config(conveyor()), state(0, few), state(0, [...few, product(2)]), state(0, many), state(0, few)),
    ).toEqual([true, false, true, false]);
  });

  it("re-renders when a component is hidden, and after a new config even with the same ids", () => {
    const frame = new SourceFrame();
    const c = config(conveyor(), delta);
    frame.next(buildScene(c, [state(0, [], TCP)], 0));

    expect(frame.next(buildScene(c, [state(0, [], TCP)], 0, new Set([20])))).toBe(true);
    frame.invalidate();
    expect(frame.next(buildScene(c, [state(0, [], TCP)], 0, new Set([20])))).toBe(true);
  });

  it("finds this frame's parts by key, and sorts its products into groups and single ones", () => {
    const frame = new SourceFrame();
    const c = config(conveyor(), delta);
    frame.next(buildScene(c, [state(0, [product(1), product(2)], TCP)], 0));
    const before = frame.part("deltas", 20)!.effector!.position;
    frame.next(buildScene(c, [state(0, [product(1), product(2, { state: "picked", lastClientId: 20 })], { ...TCP, z: 1100 })], 0));

    expect(frame.part("deltas", 20)!.effector!.position[1]).toBeCloseTo(before[1] + 0.1);
    expect(frame.part("deltas", 99)).toBeUndefined();
    expect([...frame.members.values()].map((list) => list.map((p) => p.productId))).toEqual([[1]]);
    // The picked product hangs at the TCP, and its placeholder stays on the belt: both are drawn one by one.
    expect([...frame.single.values()].map((p) => p.display).sort()).toEqual(["atTcp", "placeholder"]);
  });
});

describe("machine frame: changes across sources", () => {
  const source = (s: StateMessage, online = true): SceneSource => ({
    sourceId: "plc1",
    config: config(conveyor()),
    snapshots: [s],
    renderTime: 0,
    online,
  });

  it("tells when a source goes offline and when faults change, not while the belt moves", () => {
    const frame = new MachineFrame();
    const next = (s: SceneSource) => frame.next(buildMachineScene([s], new Set()));

    expect(next(source(state(0, [])))).toEqual({ structure: true, faults: true });
    expect(next(source(state(80, [])))).toEqual({ structure: false, faults: false });
    expect(next(source(state(80, []), false))).toEqual({ structure: true, faults: false });
    expect(next(source(state(80, [], undefined, "Jam"), false))).toEqual({ structure: false, faults: true });
    expect(frame.source("plc1")?.conveyors).toHaveLength(1);
    expect(frame.source("plc2")).toBeUndefined();
    expect(componentKey("plc1", 1)).toBe("plc1#1");
  });
});
