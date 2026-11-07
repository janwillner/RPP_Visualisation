import { bench, describe } from "vitest";
import {
  GatewayMessageSchema,
  PROTOCOL_VERSION,
  RegisterDecoder,
  RegisterEncoder,
  type ConfigMessage,
  type ConveyorConfig,
  type ConveyorState,
  type StateMessage,
} from "@rpp/protocol";
import type { SourceInfo } from "../src/connection";
import { ProductHistory } from "../src/product-history";
import { Recorder } from "../src/recording";
import { buildMachineScene } from "../src/scene/scene-model";

/**
 * What the browser spends per state message and per frame as the product register grows: receiving a message (parse
 * and check), following the products (history, replay buffer) and building the scene. Run with `pnpm bench`;
 * compare before and after a change on the same machine. A frame at 60 Hz has 16.7 ms for everything.
 */
const PRODUCT_COUNTS = [500, 2000, 4800];
const CYCLE_MS = 20;

const conveyor: ConveyorConfig = {
  type: "conveyor",
  id: 1,
  sourceId: "bench",
  name: "Buffer belt",
  pose: { x: 0, y: 0, z: 800, rx: 0, ry: 0, rz: 0 },
  originShift: { x: 0, y: 0, z: 0 },
  length: 20000,
  width: 1100,
  productTypes: [{ id: 1, length: 120, width: 80, height: 40, shape: "box", cornerRadius: 0 }],
  body: true,
};

const config: ConfigMessage = {
  kind: "config",
  sourceId: "bench",
  protocolVersion: PROTOCOL_VERSION,
  configVersion: 1,
  components: [conveyor],
  errors: [],
};

const source: SourceInfo = { sourceId: "bench", name: "Bench", status: { plcConnected: true }, config };

/** The state of cycle `i`: the belt has moved on, every 25th product has been rejected. */
function stateAt(products: number, i: number): StateMessage {
  const belt: ConveyorState = {
    type: "conveyor",
    id: 1,
    timestamp: String(i * CYCLE_MS * 1_000_000),
    beltPosition: i * 6,
    products: Array.from({ length: products }, (_, k) => ({
      id: k + 1,
      latchPose: { x: 20000 - k * 4, y: ((k % 10) - 4.5) * 100, z: 0, rz: 0 },
      latchBeltPosition: 0,
      state: k % 25 === 0 ? "rejected" : "detected",
      previousState: "detected",
      lastClientId: 50,
      moverId: 0,
      fingerId: 0,
      productType: 1,
    })),
    fault: null,
  };
  return { kind: "state", sourceId: "bench", configVersion: 1, timestamp: belt.timestamp, tRel: i * CYCLE_MS, components: [belt] };
}

/**
 * 50 states as the register decoder gives them, in a loop: from one to the next, one product of 25 changes its state
 * (a new object), every other product is the same object as before.
 */
function decodedStates(products: number): StateMessage[] {
  const base = stateAt(products, 0).components[0]!;
  if (base.type !== "conveyor") throw new Error("conveyor expected");
  const changed = base.products.map((p) => ({ ...p, state: p.state === "detected" ? "assigned" : "detected" }) as const);
  return Array.from({ length: 50 }, (_, j) => {
    const belt: ConveyorState = {
      ...base,
      beltPosition: j * 6,
      // Product k changes at state k % 25 and back 25 states later.
      products: base.products.map((p, k) => ((j - (k % 25) + 50) % 50 < 25 ? changed[k]! : p)),
    };
    return { kind: "state", sourceId: "bench", configVersion: 1, timestamp: String(j), tRel: j * CYCLE_MS, components: [belt] };
  });
}

for (const products of PRODUCT_COUNTS) {
  describe(`${products} products on one conveyor`, () => {
    const states = [0, 1, 2].map((i) => stateAt(products, i));
    const json = JSON.stringify(states[0]);

    bench("receive a state message: JSON.parse and schema check", () => {
      GatewayMessageSchema.safeParse(JSON.parse(json));
    });

    // In register form (ADR 0013): from one cycle to the next, one product of 25 changed its state.
    const encoder = new RegisterEncoder();
    encoder.encode(states[0]!);
    const next = stateAt(products, 0);
    for (const c of next.components) if (c.type === "conveyor") c.products.forEach((p, k) => k % 25 === 1 && (p.state = "assigned"));
    const changesJson = JSON.stringify(encoder.encode(next));
    const decoder = new RegisterDecoder();
    decoder.decode({ ...states[0]!, registers: { 1: states[0]!.components[0]!.type === "conveyor" ? states[0]!.components[0]!.products.map((p) => p.id) : [] } });
    bench("receive a state message in register form: JSON.parse, schema check and decode", () => {
      const parsed = GatewayMessageSchema.safeParse(JSON.parse(changesJson));
      if (parsed.success && parsed.data.kind === "state") decoder.decode(parsed.data);
    });

    const history = new ProductHistory(5000, 120_000);
    let at = 0;
    bench("follow the products of a state message (product history)", () => {
      at += CYCLE_MS;
      history.add(at, states[(at / CYCLE_MS) % 3]!, source);
    });

    // Live, states come from the register decoder: unchanged products are the same objects as in the previous state.
    const live = decodedStates(products);
    const liveHistory = new ProductHistory(5000, 120_000);
    let liveAt = 0;
    bench("follow the products of a decoded state message (product history, live)", () => {
      liveAt += CYCLE_MS;
      liveHistory.add(liveAt, live[(liveAt / CYCLE_MS) % live.length]!, source);
    });

    const replay = Recorder.replayBuffer();
    replay.add(0, config);
    let recorded = 0;
    bench("keep a state message in the replay buffer", () => {
      recorded += CYCLE_MS;
      replay.add(recorded, states[(recorded / CYCLE_MS) % 3]!, json);
    });

    const liveReplay = Recorder.replayBuffer();
    liveReplay.add(0, config);
    let liveRecorded = 0;
    bench("keep a decoded state message in the replay buffer (live)", () => {
      liveRecorded += CYCLE_MS;
      liveReplay.add(liveRecorded, live[(liveRecorded / CYCLE_MS) % live.length]!, json);
    });

    const sources = [{ sourceId: "bench", config, snapshots: states, renderTime: CYCLE_MS * 1.5, online: true }];
    bench("build the machine scene, measuring (once per frame)", () => {
      buildMachineScene(sources, new Set());
    });

    bench("build the machine scene, not measuring: no product snap points", () => {
      buildMachineScene(sources, new Set(), { productSnapPoints: false });
    });
  });
}
