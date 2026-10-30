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

    // The loop and the gantry carry products on their movers and hand them on downstream.
    const byId = new Map(config.components.map((c) => [c.id, c.type]));
    const carriedBy = new Set(products.filter((p) => p.state === "picked" && p.moverId > 0).map((p) => byId.get(p.robotId)));
    expect(carriedBy).toEqual(new Set(["xtsLoop", "xtsGantry"]));
    const last = states.at(-1)!.components;
    const productsOn = (name: string) => {
      const id = config.components.find((c) => c.name === name)!.id;
      const c = last.find((x) => x.id === id);
      return c?.type === "conveyor" ? c.products.length : 0;
    };
    expect(productsOn("Spacing belt")).toBeGreaterThan(0);
    expect(productsOn("Tray belt")).toBeGreaterThan(0);

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
  });
});
