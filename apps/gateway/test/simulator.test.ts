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
      "sensor",
      "station",
      "vision",
      "xtsGantry",
      "xtsLoop",
    ]);

    const states = messages.filter((m): m is StateMessage => m.kind === "state");
    expect(states).toHaveLength(3000);
    const products = states.flatMap((s) => s.components.flatMap((c) => (c.type === "conveyor" ? c.products : [])));
    expect(new Set(products.map((p) => p.state))).toEqual(new Set(["detected", "assigned", "picked", "placed", "rejected"]));

    // The vision system latches the Delta infeed's products, the light barrier the Cartesian infeed's, and its beam
    // lights up while a product passes it. A product nobody changed since its latch names the client that latched it.
    const idOf = (name: string) => config.components.find((c) => c.name === name)!.id;
    const detectors = (belt: string) =>
      new Set(states.flatMap((s) => s.components.flatMap((c) => (c.id === idOf(belt) && c.type === "conveyor" ? c.products.filter((p) => p.state === "detected" && p.previousState === "detected").map((p) => p.lastClientId) : []))));
    expect(detectors("Infeed")).toEqual(new Set([idOf("Vision 1")]));
    expect(detectors("Cartesian infeed")).toEqual(new Set([idOf("Light barrier")]));
    const beam = states.map((s) => s.components.find((c) => c.type === "sensor"));
    const lit = beam.map((c) => c?.type === "sensor" && c.bodies[1]!.active);
    expect(new Set(lit)).toEqual(new Set([true, false]));
    // A product of 120 mm at 150 mm/s covers it for about 0.8 s: 40 cycles of 20 ms.
    const longest = lit.reduce((run, on, i) => (on ? Math.max(run, lit.slice(0, i + 1).reverse().findIndex((x) => !x)) : run), 0);
    expect(longest).toBeGreaterThan(30);

    // The reject unit on the Delta outfeed rejects placed products: the change names it and the state before, and its
    // pusher lights up while it pushes one off.
    const rejected = products.filter((p) => p.state === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    expect(new Set(rejected.map((p) => `${p.previousState} by ${p.lastClientId}`))).toEqual(
      new Set([`placed by ${idOf("Reject unit")}`]),
    );
    const pusher = states.map((s) => s.components.find((c) => c.type === "station"));
    expect(new Set(pusher.map((c) => c?.type === "station" && c.bodies[1]!.active))).toEqual(new Set([true, false]));

    // The loop and the gantry carry products on their movers and hand them on to their own outfeeds.
    const byId = new Map(config.components.map((c) => [c.id, c.type]));
    const carriedBy = new Set(products.filter((p) => p.state === "picked" && p.moverId > 0).map((p) => byId.get(p.lastClientId)));
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
      products.some((p) => p.state === "picked" && p.lastClientId === cartesianId && p.moverId === 0 && p.fingerId === 1),
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

  it("puts a Fxx mover, an IDH mover, a Fxx track module and the Delta into a fault now and then and clears it again", async () => {
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
    const moduleFaults = states.map((s) => {
      const c = s.components.find((x) => x.type === "xtsLoop");
      return c?.type === "xtsLoop" ? c.modules.flatMap((m, i) => (m.fault ? [i + 1] : [])) : [];
    });
    // The first curve module after the lower straight of ten modules.
    expect(moduleFaults.some((m) => m.length === 1 && m[0] === 11)).toBe(true);
    expect(moduleFaults.some((m) => m.length === 0)).toBe(true);
    const deltaFaults = faultsOf("delta").map((f) => f.component);
    expect(deltaFaults.some((f) => f !== null && f.message.length > 0)).toBe(true);
    expect(deltaFaults.some((f) => f === null)).toBe(true);
  }, 30_000);
});
