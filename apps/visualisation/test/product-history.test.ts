import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  RegisterDecoder,
  RegisterEncoder,
  type ConfigMessage,
  type Product,
  type StateMessage,
} from "@rpp/protocol";
import type { SourceInfo } from "@rpp/machine-view";
import { ProductHistory } from "../src/product-history";
import { Recorder, Recording } from "../src/recording";

const A = "ads:5.1.2.3.1.1:851";

const config: ConfigMessage = {
  kind: "config",
  sourceId: A,
  protocolVersion: PROTOCOL_VERSION,
  configVersion: 1,
  errors: [],
  components: [
    {
      type: "conveyor",
      id: 1,
      sourceId: A,
      name: "Infeed",
      pose: { x: 0, y: 0, z: 800, rx: 0, ry: 0, rz: 0 },
      length: 3000,
      width: 400,
      productTypes: [],
      body: true,
      originShift: { x: 0, y: 0, z: 0 },
    },
  ],
};
const source: SourceInfo = { sourceId: A, name: "Infeed PLC", status: { plcConnected: true }, config };

function product(
  id: number,
  state: Product["state"],
  lastClientId = 0,
  fingerId = 0,
  previousState: Product["state"] = "detected",
): Product {
  return {
    id,
    latchPose: { x: 100, y: 0, z: 0, rz: 0 },
    latchBeltPosition: 0,
    state,
    previousState,
    lastClientId,
    moverId: 0,
    fingerId,
    productType: 1,
  };
}

/** A state of the infeed with its belt at `beltPosition` mm and these products in the register. */
function register(beltPosition: number, products: Product[]): StateMessage {
  return {
    kind: "state",
    sourceId: A,
    configVersion: 1,
    timestamp: "0",
    tRel: beltPosition,
    components: [{ type: "conveyor", id: 1, timestamp: "0", beltPosition, products, fault: null }],
  };
}

/** The products of a state's first conveyor. */
function componentProducts(state: StateMessage): Product[] {
  const c = state.components[0]!;
  return c.type === "conveyor" ? c.products : [];
}

describe("product history", () => {
  it("lists what happened to a product: registered, assigned, picked by its robot, placed, gone", () => {
    const history = new ProductHistory();
    const timeline: [number, Product[]][] = [
      [0, [product(5, "detected")]],
      [100, [product(5, "detected")]],
      [200, [product(5, "assigned", 10)]],
      [600, [product(5, "picked", 10, 2)]],
      [900, [product(5, "placed", 10, 2)]],
      [1000, []],
      [1100, []],
    ];
    for (const [at, products] of timeline) history.add(at, register(0, products), source);

    expect(history.of(A, 1, 5)).toEqual([
      { at: 0, kind: "detected", text: "Entered the register (detected)" },
      { at: 200, kind: "assigned", text: "Assigned to client #10" },
      { at: 600, kind: "picked", text: "Picked by client #10, finger 2" },
      { at: 900, kind: "placed", text: "Placed by client #10" },
      { at: 1000, kind: "gone", text: "Left the register" },
    ]);
    // Up to a moment, e.g. during playback.
    expect(history.of(A, 1, 5, 600).map((s) => s.kind)).toEqual(["detected", "assigned", "picked"]);
    expect(history.of(A, 1, 99)).toEqual([]);
  });

  it("names the client that changed a product: a station that rejected it, a robot that released it", () => {
    const withClients: SourceInfo = {
      ...source,
      config: {
        ...config,
        components: [
          ...config.components,
          { ...config.components[0]!, id: 10, name: "Delta 1" },
          { ...config.components[0]!, type: "station", id: 70, name: "Reject unit", zones: [], bodies: [] } as ConfigMessage["components"][number],
        ],
      },
    };
    const history = new ProductHistory();
    history.add(0, register(0, [product(5, "detected"), product(6, "detected")]), withClients);
    history.add(100, register(0, [product(5, "assigned", 10), product(6, "rejected", 70)]), withClients);
    // The robot gives the product up: back to detected, the state before was assigned.
    history.add(200, register(0, [product(5, "detected", 10, 0, "assigned"), product(6, "rejected", 70)]), withClients);

    expect(history.of(A, 1, 5).map((s) => s.text)).toEqual([
      "Entered the register (detected)",
      "Assigned to Delta 1",
      "Released by Delta 1",
    ]);
    expect(history.of(A, 1, 6).map((s) => s.text)).toEqual(["Entered the register (detected)", "Rejected by Reject unit"]);
  });

  it("names the detector that latched a product", () => {
    const withVision: SourceInfo = {
      ...source,
      config: {
        ...config,
        components: [
          ...config.components,
          { ...config.components[0]!, type: "vision", id: 60, name: "Vision 1", zones: [], bodies: [] } as ConfigMessage["components"][number],
        ],
      },
    };
    const history = new ProductHistory();
    history.add(0, register(0, [product(5, "detected", 60)]), withVision);
    history.add(0, register(0, [product(5, "detected", 60), product(6, "detected", 61)]), withVision);
    expect(history.of(A, 1, 5)[0]!.text).toBe("Entered the register (detected by Vision 1)");
    expect(history.of(A, 1, 6)[0]!.text).toBe("Entered the register (detected by client #61)");
  });

  it("names the robot from the config, and marks a product that passes the belt end unpicked as missed", () => {
    const withDelta: SourceInfo = {
      ...source,
      config: {
        ...config,
        components: [...config.components, { ...config.components[0]!, id: 10, name: "Delta 1" }],
      },
    };
    const history = new ProductHistory();
    history.add(0, register(0, [product(7, "assigned", 10)]), withDelta);
    // Latched at x = 100 on a 3000 mm belt: past its end after 2900 mm of travel.
    history.add(1000, register(2800, [product(7, "assigned", 10)]), withDelta);
    history.add(2000, register(3000, [product(7, "assigned", 10)]), withDelta);
    history.add(2100, register(3100, [product(7, "assigned", 10)]), withDelta);

    expect(history.of(A, 1, 7)).toEqual([
      { at: 0, kind: "assigned", text: "Entered the register (assigned to Delta 1)" },
      { at: 2000, kind: "missed", text: "Missed: passed the belt end" },
    ]);
  });

  it("follows decoded states, whose unchanged products are the objects of the previous state", () => {
    // Live, the register decoder gives an unchanged product as the same object (ADR 0013).
    const encoder = new RegisterEncoder();
    const decoder = new RegisterDecoder();
    const history = new ProductHistory(5000, Infinity);
    const timeline: [number, number, Product[]][] = [
      [0, 0, [product(5, "detected"), product(7, "detected")]],
      [100, 0, [product(5, "detected"), product(7, "detected")]],
      [200, 0, [product(5, "assigned", 10), product(7, "detected"), product(8, "detected")]],
      [300, 2800, [product(5, "picked", 10, 2), product(7, "detected"), product(8, "detected")]],
      // Product 7 passes the belt end without a change of its own.
      [400, 3000, [product(5, "picked", 10, 2), product(7, "detected"), product(8, "detected")]],
      [500, 3100, [product(5, "placed", 10, 2), product(8, "detected")]],
    ];
    let previous: StateMessage | undefined;
    for (const [at, beltPosition, products] of timeline) {
      const state = decoder.decode(encoder.encode(register(beltPosition, products)));
      // Product 7 (second in the register until it leaves) never changes.
      if (previous && at <= 400) expect(componentProducts(state)[1]).toBe(componentProducts(previous)[1]);
      previous = state;
      history.add(at, state, source);
    }

    expect(history.of(A, 1, 5).map((s) => [s.at, s.kind])).toEqual([
      [0, "detected"],
      [200, "assigned"],
      [300, "picked"],
      [500, "placed"],
    ]);
    expect(history.of(A, 1, 7).map((s) => [s.at, s.kind])).toEqual([
      [0, "detected"],
      [400, "missed"],
      [500, "gone"],
    ]);
    expect(history.of(A, 1, 8).map((s) => [s.at, s.kind])).toEqual([
      [200, "detected"],
      [400, "missed"],
    ]);
    expect(history.events(0, Infinity).map((e) => [e.at, e.productId, e.kind])).toEqual([
      [200, 8, "entered"],
      [300, 5, "picked"],
      [400, 7, "missed"],
      [400, 8, "missed"],
      [500, 5, "placed"],
    ]);
  });

  it("keeps the history of an earlier product with the same id for the moments before it came back", () => {
    // As in a recording, which follows every product.
    const history = new ProductHistory(Infinity);
    history.add(0, register(0, [product(5, "detected")]), source);
    history.add(100, register(0, []), source);
    history.add(200, register(0, [product(5, "assigned", 10)]), source);

    expect(history.of(A, 1, 5, 150).map((s) => [s.at, s.kind])).toEqual([
      [0, "detected"],
      [100, "gone"],
    ]);
    expect(history.of(A, 1, 5, 250).map((s) => [s.at, s.kind])).toEqual([[200, "assigned"]]);
    expect(history.of(A, 1, 5).map((s) => s.at)).toEqual([200]);
  });

  it("forgets the oldest products beyond its limit", () => {
    const history = new ProductHistory(2);
    history.add(0, register(0, [product(1, "detected")]), source);
    history.add(100, register(0, [product(1, "detected"), product(2, "detected")]), source);
    history.add(200, register(0, [product(2, "detected"), product(3, "detected")]), source);

    expect(history.of(A, 1, 1)).toEqual([]);
    expect(history.of(A, 1, 2).length).toBe(1);
    expect(history.of(A, 1, 3).length).toBe(1);
  });

  it("is part of a recording, also of one opened from a file", async () => {
    const recorder = new Recorder([source]);
    recorder.add(0, register(0, [product(5, "detected")]));
    recorder.add(500, register(0, [product(5, "picked", 10)]));
    recorder.add(800, register(0, []));
    const recording = await recorder.stop();

    for (const opened of [recording, await Recording.fromFile(await recording.toFile())]) {
      expect(opened.products.of(A, 1, 5, 600).map((s) => s.text)).toEqual([
        "Entered the register (detected)",
        "Picked by client #10",
      ]);
    }
  });
});
