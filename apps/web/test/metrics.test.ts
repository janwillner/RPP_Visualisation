import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ComponentConfig, type Product, type StateMessage } from "@rpp/protocol";
import type { SourceInfo } from "../src/sources";
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
  body: true,
  originShift: { x: 0, y: 0, z: 0 },
});

/** The metrics only take a client's id and name from the config, so any component type stands in for one. */
const client = conveyor;

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
      components: [
        conveyor(1, "Infeed"),
        client(10, "Delta 1"),
        client(11, "Delta 2"),
        client(60, "Vision 1"),
        client(70, "Reject unit"),
      ],
    },
  },
];

/** An event of product `productId` by `clientId`; an entered product is detected unless `state` says otherwise. */
const event = (
  at: number,
  kind: ProductEvent["kind"],
  clientId = 0,
  productId = at,
  state: ProductEvent["state"] = kind === "entered" || kind === "missed" ? "detected" : kind,
): ProductEvent => ({ at, sourceId: A, conveyorId: 1, productId, kind, clientId, state });

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
    expect(m.clients).toEqual([
      { sourceId: A, clientId: 10, name: "Delta 1", perMin: { picked: 24 } },
      { sourceId: A, clientId: 11, name: "Delta 2", perMin: { picked: 6 } },
    ]);
    expect(m.conveyors).toEqual([
      { sourceId: A, conveyorId: 1, name: "Infeed", inPerMin: 30, missed: 1, rejected: 1 },
    ]);
    expect(m.missed).toBe(1);
    // 1 missed of 31 products that were either picked or missed.
    expect(m.missedShare).toBeCloseTo(1 / 31);
  });

  it("counts what each client did per minute: detected, picked, placed onto a belt, rejected", () => {
    const events = [
      // Latched by the vision system, or by nobody named.
      ...Array.from({ length: 20 }, (_, i) => event(41_000 + i * 1000, "entered", 60, i)),
      ...Array.from({ length: 5 }, (_, i) => event(41_500 + i * 1000, "entered", 0, 100 + i)),
      // Delta 1 picks 10 and puts them down onto this belt, where they enter as placed.
      ...Array.from({ length: 10 }, (_, i) => event(50_000 + i * 1000, "picked", 10, 200 + i)),
      ...Array.from({ length: 10 }, (_, i) => event(50_500 + i * 1000, "entered", 10, 300 + i, "placed")),
      ...Array.from({ length: 3 }, (_, i) => event(80_000 + i * 1000, "rejected", 70, 300 + i)),
    ];
    expect(metrics(events, 100_000, 0, sources).clients).toEqual([
      { sourceId: A, clientId: 10, name: "Delta 1", perMin: { picked: 10, placed: 10 } },
      { sourceId: A, clientId: 60, name: "Vision 1", perMin: { detected: 20 } },
      { sourceId: A, clientId: 70, name: "Reject unit", perMin: { rejected: 3 } },
    ]);
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
    expect(m.clients[0]!.name).toBe("#42");
    expect(m.conveyors[0]!.name).toBe("#7");
  });
});

describe("product history: countable events", () => {
  const product = (id: number, state: Product["state"], lastClientId = 0): Product => ({
    id,
    latchPose: { x: 100, y: 0, z: 0, rz: 0 },
    latchBeltPosition: 0,
    state,
    previousState: "detected",
    lastClientId,
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

  it("logs entered, picked, placed, rejected and missed products in time order, each with its client", () => {
    const history = new ProductHistory();
    // The register is known before: products appearing from now on count.
    history.add(-100, register(0, []), sources[0]);
    history.add(0, register(0, [product(1, "detected", 60), product(2, "detected")]), sources[0]);
    history.add(100, register(0, [product(1, "assigned", 10), product(2, "rejected", 70)]), sources[0]);
    history.add(200, register(0, [product(1, "picked", 10), product(2, "rejected", 70)]), sources[0]);
    history.add(300, register(0, [product(1, "placed", 10), product(3, "detected")]), sources[0]);
    history.add(400, register(3000, [product(3, "detected")]), sources[0]);

    expect(history.events(0, 400).map((e) => [e.at, e.productId, e.kind, e.clientId])).toEqual([
      [0, 1, "entered", 60],
      [0, 2, "entered", 0],
      [100, 2, "rejected", 70],
      [200, 1, "picked", 10],
      [300, 1, "placed", 10],
      [300, 3, "entered", 0],
      [400, 3, "missed", 0],
    ]);
    expect(history.events(150, 300).map((e) => e.at)).toEqual([200, 300, 300]);
  });

  it("does not count what is already in a register when it is first seen as entered or missed", () => {
    const history = new ProductHistory();
    // First sight of the register: product 1 lies there already, product 9 is already past the belt end.
    history.add(0, register(0, [product(1, "detected"), { ...product(9, "detected"), latchBeltPosition: -3000 }]), sources[0]);
    history.add(100, register(0, [product(1, "detected"), product(2, "detected")]), sources[0]);
    expect(history.events(0, 100).map((e) => [e.productId, e.kind])).toEqual([[2, "entered"]]);
  });

  it("counts a pick that happened between two states, seen only as placed", () => {
    const history = new ProductHistory();
    history.add(0, register(0, []), sources[0]);
    history.add(100, register(0, [product(1, "assigned", 10)]), sources[0]);
    history.add(200, register(0, [product(1, "placed", 10)]), sources[0]);
    expect(history.events(0, 200).map((e) => [e.at, e.kind, e.clientId, e.state])).toEqual([
      [100, "entered", 10, "assigned"],
      [200, "picked", 10, "picked"],
      [200, "placed", 10, "placed"],
    ]);
  });

  it("forgets only products that have left their register, so those still on a belt are not counted again", () => {
    const history = new ProductHistory(2);
    history.add(0, register(0, []), sources[0]);
    history.add(100, register(0, [product(1, "detected"), product(2, "detected"), product(3, "detected")]), sources[0]);
    history.add(200, register(0, [product(1, "detected"), product(2, "detected"), product(3, "detected")]), sources[0]);
    expect(history.events(0, 200).filter((e) => e.kind === "entered").map((e) => e.productId)).toEqual([1, 2, 3]);
    expect(history.of(A, 1, 1).length).toBe(1);
  });

  it("keeps events only as long as asked", () => {
    const history = new ProductHistory(5000, 1000);
    for (let at = 0; at <= 3000; at += 500) history.add(at, register(0, [product(at, "detected")]), sources[0]);
    expect(history.events(0, 3000).map((e) => e.at)).toEqual([2000, 2500, 3000]);
  });
});
