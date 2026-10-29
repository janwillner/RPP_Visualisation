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

    // 20 simulated seconds at a 20 ms cycle.
    for (let i = 0; i < 1000; i++) {
      sim.step(20);
      await gateway.cycle();
    }

    const config = messages.find((m): m is ConfigMessage => m.kind === "config")!;
    expect(config.errors).toEqual([]);
    expect(config.components.map((c) => c.type).sort()).toEqual(["conveyor", "conveyor", "delta"]);

    const states = messages.filter((m): m is StateMessage => m.kind === "state");
    expect(states).toHaveLength(1000);
    const seen = new Set(states.flatMap((s) => s.components.flatMap((c) => (c.type === "conveyor" ? c.products : []))).map((p) => p.state));
    expect(seen).toEqual(new Set(["detected", "assigned", "picked", "placed"]));
  });
});
