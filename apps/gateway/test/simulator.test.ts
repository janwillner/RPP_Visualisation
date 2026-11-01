import { describe, expect, it } from "vitest";
import { GatewayMessageSchema, type ConfigMessage, type GatewayMessage, type StateMessage } from "@rpp/protocol";
import { createGateway } from "../src/gateway";
import { createSimulator } from "../src/simulator";

describe("simulator", () => {
  it("presents a sample machine that discovers without errors and produces tracked, picked and placed products", async () => {
    const sim = createSimulator({ seed: 1 });
    const gateway = createGateway({ plc: sim.plc, sourceId: "sim" });
    const messages: GatewayMessage[] = [];
    gateway.subscribe((m) => messages.push(GatewayMessageSchema.parse(JSON.parse(JSON.stringify(m)))));

    // 60 simulated seconds at a 20 ms cycle.
    for (let i = 0; i < 3000; i++) {
      sim.step(20);
      await gateway.cycle();
    }

    const config = messages.find((m): m is ConfigMessage => m.kind === "config")!;
    expect(config.errors).toEqual([]);
    expect(config.components.map((c) => c.type).sort()).toEqual([
      "cartesian",
      "conveyor",
      "conveyor",
      "conveyor",
      "conveyor",
      "conveyor",
      "conveyor",
      "conveyor",
      "conveyor",
      "delta",
      "xtsGantry",
      "xtsLoop",
    ]);

    const states = messages.filter((m): m is StateMessage => m.kind === "state");
    expect(states).toHaveLength(3000);
    const products = states.flatMap((s) => s.components.flatMap((c) => (c.type === "conveyor" ? c.products : [])));
    expect(new Set(products.map((p) => p.state))).toEqual(new Set(["detected", "assigned", "picked", "placed"]));

    // The loop and the gantry carry products on their movers and hand them on to their own outfeeds.
    const byId = new Map(config.components.map((c) => [c.id, c.type]));
    const carriedBy = new Set(products.filter((p) => p.state === "picked" && p.moverId > 0).map((p) => byId.get(p.robotId)));
    expect(carriedBy).toEqual(new Set(["xtsLoop", "xtsGantry"]));
    const last = states.at(-1)!.components;
    const productsOn = (name: string) => {
      const id = config.components.find((c) => c.name === name)!.id;
      const c = last.find((x) => x.id === id);
      return c?.type === "conveyor" ? c.products.length : 0;
    };
    expect(productsOn("Fxx outfeed")).toBeGreaterThan(0);
    expect(productsOn("Tray belt")).toBeGreaterThan(0);
    expect(productsOn("Cartesian outfeed")).toBeGreaterThan(0);

    // The Cartesian robot carries products at its cup (finger 1, no mover), tilting the gripper while it places them.
    const cartesianId = config.components.find((c) => c.type === "cartesian")!.id;
    expect(
      products.some((p) => p.state === "picked" && p.robotId === cartesianId && p.moverId === 0 && p.fingerId === 1),
    ).toBe(true);
    const cartesianStates = states.flatMap((s) => s.components.filter((c) => c.type === "cartesian"));
    const cupTilt = cartesianStates.map((c) => (c.type === "cartesian" ? c.fingers[0]!.pose.rx : 0));
    expect(Math.max(...cupTilt)).toBeCloseTo(20);
    expect(cartesianStates.some((c) => c.type === "cartesian" && c.fingers.every((f) => f.active))).toBe(true);
    // Every robot reports one state per configured finger.
    for (const c of config.components) {
      if (!("fingers" in c)) continue;
      const state = last.find((x) => x.id === c.id)!;
      const reported =
        state.type === "delta" || state.type === "cartesian" ? [state.fingers] : "movers" in state ? state.movers.map((m) => m.fingers) : [];
      for (const fingers of reported) expect(fingers).toHaveLength(c.fingers.length);
    }

    // Movers of a track never overlap.
    for (const s of states) {
      for (const c of s.components) {
        if (c.type !== "xtsGantry") continue;
        const positions = c.movers.map((m) => m.position).sort((a, b) => a - b);
        expect(positions[0]).toBeGreaterThanOrEqual(0);
        expect(positions.at(-1)).toBeLessThanOrEqual(1500);
        for (let i = 1; i < positions.length; i++) expect(positions[i]! - positions[i - 1]!).toBeGreaterThanOrEqual(155);
      }
    }
  }, 30_000);

  it("puts a Fxx mover, an IDH mover and the Delta into a fault now and then and clears it again", async () => {
    const sim = createSimulator({ seed: 1 });
    const gateway = createGateway({ plc: sim.plc, sourceId: "sim" });
    const states: StateMessage[] = [];
    gateway.subscribe((m) => {
      const parsed = GatewayMessageSchema.parse(JSON.parse(JSON.stringify(m)));
      if (parsed.kind === "state") states.push(parsed);
    });

    // 25 simulated seconds at a 20 ms cycle.
    for (let i = 0; i < 1250; i++) {
      sim.step(20);
      await gateway.cycle();
    }

    const faultsOf = (type: string) =>
      states.map((s) => {
        const c = s.components.find((x) => x.type === type)!;
        const movers = "movers" in c ? c.movers.filter((m) => m.fault) : [];
        return { component: c.fault, movers };
      });
    for (const type of ["xtsLoop", "xtsGantry"]) {
      const series = faultsOf(type);
      // Exactly one mover at a time, with a message, and not all the time.
      expect(series.some((f) => f.movers.length === 1 && f.movers[0]!.fault!.message.length > 0)).toBe(true);
      expect(series.some((f) => f.movers.length === 0)).toBe(true);
      expect(series.every((f) => f.movers.length <= 1 && f.component === null)).toBe(true);
    }
    const deltaFaults = faultsOf("delta").map((f) => f.component);
    expect(deltaFaults.some((f) => f !== null && f.message.length > 0)).toBe(true);
    expect(deltaFaults.some((f) => f === null)).toBe(true);
  }, 30_000);
});
