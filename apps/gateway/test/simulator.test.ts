import { describe, expect, it } from "vitest";
import { GatewayMessageSchema, type ConfigMessage, type GatewayMessage, type StateMessage } from "@rpp/protocol";
import { createGateway } from "../src/gateway";
import { createSimulator } from "../src/simulator";

describe("simulator", () => {
  it("presents a sample machine that discovers without errors and produces tracked, picked and placed products", async () => {
    const sim = createSimulator({ seed: 1 });
    const gateway = createGateway({ plc: sim.plc, sourceId: "sim" });
    const messages: GatewayMessage[] = [];
    gateway.subscribe((m) => {
      if (m.kind !== "parameters") messages.push(GatewayMessageSchema.parse(JSON.parse(JSON.stringify(m))));
    });

    // 60 simulated seconds at a 20 ms cycle.
    for (let i = 0; i < 3000; i++) {
      sim.step(20);
      await gateway.cycle();
    }

    const config = messages.find((m): m is ConfigMessage => m.kind === "config")!;
    expect(config.errors).toEqual([]);
    expect(config.components.map((c) => c.type).sort()).toEqual([
      "cartesian",
      "cartesian",
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
    // The Fxx outfeed is a conveyor without a body: only its products and axis are drawn.
    const bodiless = config.components.filter((c) => c.type === "conveyor" && !c.body).map((c) => c.name);
    expect(bodiless).toEqual(["Fxx outfeed"]);
    expect(productsOn("Tray belt")).toBeGreaterThan(0);
    expect(productsOn("Cartesian outfeed")).toBeGreaterThan(0);

    // The Cartesian robot carries products at its cup (finger 1, no mover), tilting the gripper while it places them.
    const cartesianId = config.components.find((c) => c.type === "cartesian")!.id;
    expect(
      products.some((p) => p.state === "picked" && p.lastClientId === cartesianId && p.moverId === 0 && p.fingerId === 1),
    ).toBe(true);
    const cartesianStates = states.flatMap((s) => s.components.filter((c) => c.id === cartesianId));
    const cupTilt = cartesianStates.map((c) => (c.type === "cartesian" ? c.fingers[0]!.pose.rx : 0));
    expect(Math.max(...cupTilt)).toBeCloseTo(20);
    expect(cartesianStates.some((c) => c.type === "cartesian" && c.fingers.every((f) => f.active))).toBe(true);
    // Beside it a Cartesian robot without a Y axis and one without a Z axis move without products.
    const axesOf = (name: string) => {
      const c = config.components.find((x) => x.name === name);
      return c?.type === "cartesian" ? c.axes : null;
    };
    expect([axesOf("Cartesian"), axesOf("Cartesian X-Z"), axesOf("Cartesian X-Y")]).toEqual(["xyz", "xz", "xy"]);
    // Delta 1, the IDH and the Cartesian robot show a limit area; an XTS loop has none.
    const limited = config.components.filter((c) => "limitArea" in c && c.limitArea !== null).map((c) => c.name);
    expect(limited.sort()).toEqual(["Cartesian", "Delta 1", "IDH"]);
    expect(config.components.some((c) => c.type === "xtsLoop" && "limitArea" in c)).toBe(false);
    // They have a TCP limit area too. Delta 1's leaves its limit area now and then, when it picks a product near the
    // far edge of the infeed: a real limit violation, short and repeated.
    const withTcpLimitArea = config.components.filter((c) => "tcpLimitArea" in c && c.tcpLimitArea !== null).map((c) => c.name);
    expect(withTcpLimitArea.sort()).toEqual(["Cartesian", "Delta 1", "IDH"]);
    const robot = config.components.find((c) => c.name === "Delta 1");
    if (robot?.type !== "delta" || !robot.limitArea || !robot.tcpLimitArea) throw new Error("Delta 1 without boxes");
    // The robot is not turned: its frame is the MCS moved to its pose.
    const leaves = states.map((s) => {
      const c = s.components.find((x) => x.id === robot.id);
      if (c?.type !== "delta") return false;
      const [box, limit] = [robot.tcpLimitArea!, robot.limitArea!];
      const local = { x: c.actualTcp.x - robot.pose.x, y: c.actualTcp.y - robot.pose.y, z: c.actualTcp.z - robot.pose.z };
      return (
        local.x + box.xMin < limit.xMin || local.x + box.xMax > limit.xMax ||
        local.y + box.yMin < limit.yMin || local.y + box.yMax > limit.yMax ||
        local.z + box.zMin < limit.zMin || local.z + box.zMax > limit.zMax
      );
    });
    const starts = leaves.filter((on, i) => on && !leaves[i - 1]).length;
    expect(starts).toBeGreaterThan(3);
    expect(leaves.filter(Boolean).length).toBeLessThan(leaves.length / 10);
    const xOf = (name: string) =>
      states.map((s) => s.components.find((c) => c.id === idOf(name))).map((c) => (c?.type === "cartesian" ? c.x : 0));
    for (const name of ["Cartesian X-Z", "Cartesian X-Y"]) expect(Math.max(...xOf(name)) - Math.min(...xOf(name))).toBeGreaterThan(500);
    // It stacks every second product on the one it put down before: lifted by a product height, lying on it.
    const stacked = states.some((s) => {
      const belt = s.components.find((c) => c.id === idOf("Cartesian outfeed"));
      if (belt?.type !== "conveyor") return false;
      const at = (p: (typeof belt.products)[number]) => [p.latchPose.x + belt.beltPosition - p.latchBeltPosition, p.latchPose.y];
      return belt.products.some(
        (top) =>
          top.latchPose.z > 0 &&
          belt.products.some((below) => below.latchPose.z === 0 && Math.hypot(at(top)[0]! - at(below)[0]!, at(top)[1]! - at(below)[1]!) < 20),
      );
    });
    expect(stacked).toBe(true);
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
      if (m.kind === "parameters") return;
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

  it("keeps the asked number of products on a buffer belt for load tests while they enter, are rejected and leave", async () => {
    const sim = createSimulator({ seed: 1, products: 1000 });
    const gateway = createGateway({ plc: sim.plc, sourceId: "sim" });
    const states: StateMessage[] = [];
    let config: ConfigMessage | undefined;
    gateway.subscribe((m) => {
      if (m.kind === "config") config = m;
      if (m.kind === "state") states.push(m);
    });
    // 10 simulated seconds: the belt moves 3 m, 20 rows of 10 products enter and leave.
    for (let i = 0; i < 500; i++) {
      sim.step(20);
      await gateway.cycle();
    }

    const buffer = config!.components.find((c) => c.name === "Buffer belt")!;
    expect(buffer).toMatchObject({ type: "conveyor", length: 15000 });
    const registers = states.map((s) => s.components.find((c) => c.id === buffer.id)!).map((c) => (c.type === "conveyor" ? c.products : []));
    for (const products of registers) {
      expect(products.length).toBeGreaterThanOrEqual(1000);
      expect(products.length).toBeLessThanOrEqual(1030);
    }
    const first = new Set(registers[0]!.map((p) => p.id));
    const last = new Set(registers.at(-1)!.map((p) => p.id));
    expect([...last].filter((id) => !first.has(id)).length).toBeGreaterThanOrEqual(190);
    expect(registers.at(-1)!.some((p) => p.state === "rejected")).toBe(true);
    expect(gateway.acquisition("sim")!.report()).toMatchObject({ duplicateProducts: 0, flickeringProducts: 0 });
  }, 30_000);

  it("adds no buffer belt without load test products", () => {
    const sim = createSimulator({ seed: 1 });
    expect(() => sim.plc.get("MAIN.stBufferBelt")).toThrow();
  });
});
