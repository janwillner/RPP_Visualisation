import { describe, expect, it } from "vitest";
import { GatewayMessageSchema, type GatewayMessage, type MachineReport } from "@rpp/protocol";
import { createGateway } from "../src/gateway";
import { InMemoryPlc } from "../src/in-memory-plc";
import { conveyor, defineMachine, defineMachineEntry, machineMessage, type MachineComponent } from "../src/plc-builders";
import { E_VisuMessageSeverity, E_VisuRunState, MACHINE_PATH, type ST_VisuMachine } from "../src/plc-contract";

const infeed: MachineComponent = { id: 10, name: "Infeed", path: "MAIN.stInfeed", kind: "conveyor", value: conveyor() };

/** A PLC with one conveyor and, unless left out, the machine entry `GVL_Visu.stMachine` (protocol 22). */
function setup(options: { machine?: boolean; protocolVersion?: number } = {}) {
  const plc = new InMemoryPlc();
  defineMachine(plc, [infeed], options.protocolVersion !== undefined ? { protocolVersion: options.protocolVersion } : {});
  if (options.machine ?? true) {
    defineMachineEntry(plc, {
      eRunState: E_VisuRunState.RUNNING,
      sRunStateText: "Production",
      bSimulation: true,
      messages: [
        machineMessage({ nId: 101, eSeverity: E_VisuMessageSeverity.WARNING, sText: "Product missed", nTime: 5_000_000n, nComponentId: 10 }),
        machineMessage({ nId: 7, eSeverity: E_VisuMessageSeverity.INFO, sText: "Door closed", nTime: 1_000_000n, bActive: false }),
      ],
    });
  }
  const gateway = createGateway({ plc, sourceId: "plc1" });
  const messages: GatewayMessage[] = [];
  gateway.subscribe((m) => {
    if (m.kind !== "parameters") messages.push(GatewayMessageSchema.parse(JSON.parse(JSON.stringify(m))));
  });
  const reports = () => messages.filter((m): m is MachineReport => m.kind === "machine");
  return { plc, gateway, messages, reports, machine: () => plc.get<ST_VisuMachine>(MACHINE_PATH) };
}

describe("machine run state and machine messages (protocol 22)", () => {
  it("publishes the machine's run state, simulation mode and messages, active and gone", async () => {
    const t = setup();
    await t.gateway.cycle();

    expect(t.reports()).toEqual([
      {
        kind: "machine",
        sourceId: "plc1",
        runState: "running",
        runStateText: "Production",
        simulation: true,
        messages: [
          { id: 101, severity: "warning", text: "Product missed", time: "5000000", active: true, componentId: 10 },
          { id: 7, severity: "info", text: "Door closed", time: "1000000", active: false, componentId: 0 },
        ],
      },
    ]);
  });

  it("publishes it again only when it changes: a message raised, one gone, another run state", async () => {
    const t = setup();
    await t.gateway.cycle();
    await t.gateway.cycle();
    expect(t.reports()).toHaveLength(1);

    const machine = t.machine();
    machine.aMessages[0]!.bActive = false;
    machine.aMessages[machine.nMessageCount] = machineMessage({ nId: 3, eSeverity: E_VisuMessageSeverity.ERROR, sText: "Vacuum lost", nTime: 9_000_000n });
    machine.nMessageCount += 1;
    await t.gateway.cycle();
    machine.eRunState = E_VisuRunState.FAULT;
    machine.sRunStateText = "Vacuum lost";
    await t.gateway.cycle();
    await t.gateway.cycle();

    const [, raised, fault] = t.reports();
    expect(t.reports()).toHaveLength(3);
    expect(raised!.messages.map((m) => [m.id, m.active])).toEqual([[101, false], [7, false], [3, true]]);
    expect(raised!.messages[2]).toMatchObject({ severity: "error", text: "Vacuum lost" });
    expect(fault).toMatchObject({ runState: "fault", runStateText: "Vacuum lost" });
  });

  it("sends the report again after every new config, and none once the rediscovered application has no entry", async () => {
    const t = setup();
    await t.gateway.cycle();
    const manifest = t.plc.get<{ nConfigVersion: number; nProtocolVersion: number }>("GVL_Visu.stManifest");

    manifest.nConfigVersion += 1;
    await t.gateway.cycle();
    // A client drops a source's machine with a new config: the unchanged report follows it again.
    expect(t.messages.filter((m) => m.kind === "config" || m.kind === "machine").map((m) => m.kind)).toEqual([
      "config",
      "machine",
      "config",
      "machine",
    ]);

    // E.g. the application went back to a library of protocol 21: the gateway no longer reads the entry.
    manifest.nProtocolVersion = 21;
    await t.gateway.cycle();
    await t.gateway.cycle();
    expect(t.messages.filter((m) => m.kind === "config" || m.kind === "machine").at(-1)?.kind).toBe("config");
  });

  it("hands a new client the machine's last report right after it connects", async () => {
    const t = setup();
    await t.gateway.cycle();

    const late: GatewayMessage[] = [];
    t.gateway.subscribe((m) => {
      if (m.kind !== "parameters") late.push(m);
    });
    expect(late.map((m) => m.kind)).toEqual(["status", "config", "machine"]);
  });

  it("reads an application without the machine entry as before: no report, no discovery error", async () => {
    const t = setup({ machine: false });
    await t.gateway.cycle();

    expect(t.reports()).toEqual([]);
    expect(t.messages.find((m) => m.kind === "config")).toMatchObject({ errors: [], components: [{ id: 10 }] });
    expect(t.messages.some((m) => m.kind === "state")).toBe(true);
  });

  it("still reads a PLC with protocol version 21, which knows no machine entry", async () => {
    const t = setup({ machine: false, protocolVersion: 21 });
    await t.gateway.cycle();

    expect(t.messages.find((m) => m.kind === "config")).toMatchObject({ protocolVersion: 21, errors: [] });
    expect(t.messages.some((m) => m.kind === "state")).toBe(true);
    expect(t.reports()).toEqual([]);
  });

  it("reports a machine entry of the wrong type as a discovery error and still reads the components", async () => {
    const t = setup({ machine: false });
    t.plc.define(MACHINE_PATH, "ST_SomethingElse", {});
    await t.gateway.cycle();

    const config = t.messages.find((m) => m.kind === "config");
    expect(config).toMatchObject({ components: [{ id: 10 }] });
    expect(config?.kind === "config" && config.errors.map((e) => e.path)).toEqual([MACHINE_PATH]);
    expect(t.reports()).toEqual([]);
  });
});
