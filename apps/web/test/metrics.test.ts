import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ComponentConfig, type Product, type StateMessage } from "@rpp/protocol";
import type { SourceInfo } from "../src/connection";
import { metrics } from "../src/metrics";
import { ProductHistory, type ProductEvent } from "../src/product-history";

const A = "ads:5.1.2.3.1.1:851";

const conveyor = (id: number, name: string): ComponentConfig => ({
  type: "conveyor",
  id,
  sourceId: A,
  name,
  pose: { x: 0, y: 0, z: 800, rx: 0, ry: 0, rz: 0 },
  length: 3000,
  width: 400,
  productTypes: [],
  originShift: { x: 0, y: 0, z: 0 },
});

/** The metrics only take a robot's id and name from the config, so any component type stands in for one. */
const robot = conveyor;

const sources: SourceInfo[] = [
  {
    sourceId: A,
    name: "Infeed PLC",
    status: { plcConnected: true },
    config: {
      kind: "config",
      sourceId: A,
      protocolVersion: PROTOCOL_VERSION,
      configVersion: 1,
      errors: [],
      components: [conveyor(1, "Infeed"), robot(10, "Delta 1"), robot(11, "Delta 2")],
    },
  },
];

const event = (at: number, kind: ProductEvent["kind"], robotId = 0, productId = at): ProductEvent => ({
  at,
  sourceId: A,
  conveyorId: 1,
  productId,
  kind,
  robotId,
});

describe("metrics", () => {
  it("counts per minute over the last 60 s: picks per robot, products in and missed per conveyor", () => {
    const now = 100_000;
    const events = [
      // Older than the window: not counted.
      ...Array.from({ length: 5 }, (_, i) => event(30_000 + i, "picked", 10)),
      ...Array.from({ length: 30 }, (_, i) => event(41_000 + i * 1000, "entered")),
      ...Array.from({ length: 24 }, (_, i) => event(41_000 + i * 2000, "picked", 10)),
      ...Array.from({ length: 6 }, (_, i) => event(42_000 + i * 2000, "picked", 11)),
      event(90_000, "missed"),
      event(95_000, "rejected"),
    ].sort((a, b) => a.at - b.at);

    const m = metrics(events, now, 0, sources);

    expect(m.windowMs).toBe(60_000);
    expect(m.picksPerMin).toBe(30);
    expect(m.robots).toEqual([
      { sourceId: A, robotId: 10, name: "Delta 1", picksPerMin: 24 },
      { sourceId: A, robotId: 11, name: "Delta 2", picksPerMin: 6 },
    ]);
    expect(m.conveyors).toEqual([
      { sourceId: A, conveyorId: 1, name: "Infeed", inPerMin: 30, missed: 1, rejected: 1 },
    ]);
    expect(m.missed).toBe(1);
    // 1 missed of 31 products that were either picked or missed.
    expect(m.missedShare).toBeCloseTo(1 / 31);
  });

  it("uses the time covered so far while there are not yet 60 s of data", () => {
    const events = Array.from({ length: 15 }, (_, i) => event(1000 + i * 1000, "picked", 10));
    const m = metrics(events, 30_000, 0, sources);
    expect(m.windowMs).toBe(30_000);
    expect(m.picksPerMin).toBe(30);
  });

  it("has no missed share without products, and names unknown components by their id", () => {
    expect(metrics([], 60_000, 0, sources).missedShare).toBeUndefined();
    const m = metrics([{ ...event(59_000, "picked", 42), conveyorId: 7 }], 60_000, 0, sources);
    expect(m.robots[0]!.name).toBe("#42");
    expect(m.conveyors[0]!.name).toBe("#7");
  });
});

describe("product history: countable events", () => {
  const product = (id: number, state: Product["state"], robotId = 0): Product => ({
    id,
    latchPose: { x: 100, y: 0, z: 800, rz: 0 },
    latchBeltPosition: 0,
    state,
    robotId,
    moverId: 0,
    fingerId: 0,
    productType: 1,
  });
  const register = (beltPosition: number, products: Product[]): StateMessage => ({
    kind: "state",
    sourceId: A,
    configVersion: 1,
    timestamp: "0",
    tRel: beltPosition,
    components: [{ type: "conveyor", id: 1, timestamp: "0", beltPosition, products, fault: null }],
  });

  it("logs entered, picked by which robot, placed, rejected and missed products in time order", () => {
    const history = new ProductHistory();
    history.add(0, register(0, [product(1, "detected"), product(2, "detected")]), sources[0]);
    history.add(100, register(0, [product(1, "assigned", 10), product(2, "rejected")]), sources[0]);
    history.add(200, register(0, [product(1, "picked", 10), product(2, "rejected")]), sources[0]);
    history.add(300, register(0, [product(1, "placed", 10), product(3, "detected")]), sources[0]);
    history.add(400, register(3000, [product(3, "detected")]), sources[0]);

    expect(history.events(0, 400).map((e) => [e.at, e.productId, e.kind, e.robotId])).toEqual([
      [0, 1, "entered", 0],
      [0, 2, "entered", 0],
      [100, 2, "rejected", 0],
      [200, 1, "picked", 10],
      [300, 1, "placed", 10],
      [300, 3, "entered", 0],
      [400, 3, "missed", 0],
    ]);
    expect(history.events(150, 300).map((e) => e.at)).toEqual([200, 300, 300]);
  });

  it("keeps events only as long as asked", () => {
    const history = new ProductHistory(5000, 1000);
    for (let at = 0; at <= 3000; at += 500) history.add(at, register(0, [product(at, "detected")]), sources[0]);
    expect(history.events(0, 3000).map((e) => e.at)).toEqual([2000, 2500, 3000]);
  });
});
