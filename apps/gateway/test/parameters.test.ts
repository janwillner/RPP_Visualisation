import { describe, expect, it } from "vitest";
import {
  ServerMessageSchema,
  type ConfigMessage,
  type ParametersMessage,
  type ServerMessage,
  type TypedParameters,
} from "@rpp/protocol";
import { ConfigEmulation } from "../src/config-emulation";
import { createGateway, type GatewayCommandResult } from "../src/gateway";
import { NOT_ALLOWED } from "../src/parameter-access";
import { InMemoryPlc } from "../src/in-memory-plc";
import { cartesian, conveyor, defineMachine, delta, detector, station, xtsGantry, xtsLoop } from "../src/plc-builders";
import type { MachineComponent } from "../src/plc-builders";

const ZONE = { nConveyorId: 1, fStart: 1100, fEnd: 1900, fAllocationOffset: 0, fCcsOffset: 1100, fStartY: 0, fEndY: 0 };

/** A PLC with a conveyor (1) and a Delta (10), both parametrised through Syn_Config, read by a gateway. */
function setup(options: { allowWrite?: boolean; config?: boolean } = {}) {
  const plc = new InMemoryPlc();
  defineMachine(plc, [
    { id: 1, name: "Infeed", path: "MAIN.stInfeed", kind: "conveyor", value: conveyor({ pose: { fX: 0, fY: 0, fZ: 800 }, length: 3000 }) },
    { id: 10, name: "Delta 1", path: "MAIN.stDelta1", kind: "delta", value: delta({ pose: { fX: 1500, fY: 0, fZ: 1900 }, zones: [ZONE] }) },
  ]);
  const emulation =
    options.config === false
      ? undefined
      : new ConfigEmulation(plc, [
          { id: 1, kind: "conveyor", path: "MAIN.fbInfeedParam.vo_Config", visuPath: "MAIN.stInfeed" },
          { id: 10, kind: "delta", path: "MAIN.fbDelta1Param.vo_Config", visuPath: "MAIN.stDelta1" },
        ]);
  const gateway = createGateway({ plc, sourceId: "plc1", allowWrite: options.allowWrite ?? true, now: () => 0 });
  const messages: ServerMessage[] = [];
  gateway.subscribe((m) => messages.push(ServerMessageSchema.parse(JSON.parse(JSON.stringify(m)))));
  const last = <K extends ServerMessage["kind"]>(kind: K) =>
    messages.filter((m): m is Extract<ServerMessage, { kind: K }> => m.kind === kind).at(-1);
  /** One PLC cycle (the application with Syn_Config), then one gateway cycle. */
  const cycle = async () => {
    emulation?.step();
    await gateway.cycle();
  };
  return { plc, emulation, gateway, messages, last, cycle };
}

const component = (m: ParametersMessage | undefined, id: number) => m?.components.find((c) => c.id === id);

describe("parameter sets (Syn_Config, ADR 0017)", () => {
  it("publishes every parameter FB's status and effective values, the program values while no set is active", async () => {
    const { last, cycle } = setup();
    await cycle();

    const message = last("parameters");
    expect(message).toMatchObject({ sourceId: "plc1", writable: true });
    expect(component(message, 1)).toMatchObject({
      id: 1,
      activeVersion: 0,
      handledStageId: 0,
      result: "none",
      message: "",
      set: { type: "conveyor", parameters: { pose: { x: 0, y: 0, z: 800 }, productTypes: [{ id: 1, length: 100, width: 80 }] } },
    });
    expect(component(message, 10)?.set).toMatchObject({
      type: "delta",
      parameters: { zones: [{ conveyorId: 1, start: 1100, end: 1900 }], limitArea: null },
    });
  });

  it("stages a written set; once the application takes it over, the parameters and the visualisation show it", async () => {
    const { last, cycle, gateway } = setup();
    await cycle();
    const before = component(last("parameters"), 10)!;
    const set: TypedParameters = before.set.type === "delta" ? structuredClone(before.set) : (undefined as never);
    if (set.type !== "delta") throw new Error("not a delta");
    set.parameters.zones[0]!.end = 2100;
    set.parameters.zones.push({ conveyorId: 1, start: 2200, end: 2600, allocationOffset: 0, ccsOffset: 2200, startY: 50, endY: 150 });
    set.parameters.limitArea = { xMin: -500, xMax: 500, yMin: -500, yMax: 500, zMin: -1400, zMax: -700 };

    const result = (await gateway.command({
      kind: "writeParameters",
      requestId: 1,
      sourceId: "plc1",
      componentId: 10,
      baseVersion: 0,
      set,
    })) as Extract<GatewayCommandResult, { ok: true }>;
    expect(result).toMatchObject({ ok: true, stageId: expect.any(Number) });

    await cycle();
    expect(component(last("parameters"), 10)).toMatchObject({
      activeVersion: 1,
      handledStageId: result.stageId,
      result: "applied",
      set,
    });
    const robot = (last("config") as ConfigMessage).components.find((c) => c.id === 10);
    expect(robot).toMatchObject({ zones: set.parameters.zones, limitArea: set.parameters.limitArea });
  });

  it("refuses a write based on another active version, for an unknown component or of another type", async () => {
    const { last, cycle, gateway } = setup();
    await cycle();
    const conveyorSet = component(last("parameters"), 1)!.set;
    const write = (componentId: number, baseVersion: number, set = conveyorSet) =>
      gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId, baseVersion, set });

    expect(await write(1, 3)).toEqual({
      ok: false,
      error: "Component 1 has parameter version 0 active, not 3: reconcile again before writing.",
    });
    expect(await write(7, 0)).toMatchObject({ ok: false, error: expect.stringMatching(/no parameter FB/) });
    expect(await write(10, 0)).toMatchObject({ ok: false, error: "Component 10 is a delta in the PLC, not a conveyor." });
  });

  it("keeps reading the visualisation when the config manifest has another layout, and says why nothing can be written", async () => {
    const { plc, last, cycle } = setup();
    plc.define("GVL_Config.stManifest", "ST_SomethingElse", { nVersion: 3 });
    await cycle();
    expect(last("status")).toMatchObject({ status: { plcConnected: true } });
    expect(last("state")).toBeDefined();
    expect(last("parameters")).toMatchObject({ writable: false, components: [], reason: expect.stringMatching(/Syn_Config/) });
  });

  it("reports a set the application rejects, with its reason", async () => {
    const { last, cycle, gateway } = setup();
    await cycle();
    const set = structuredClone(component(last("parameters"), 10)!.set);
    if (set.type !== "delta") throw new Error("not a delta");
    set.parameters.zones[0]!.conveyorId = 0;
    const result = await gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId: 10, baseVersion: 0, set });

    await cycle();
    expect(component(last("parameters"), 10)).toMatchObject({
      activeVersion: 0,
      handledStageId: (result as { stageId: number }).stageId,
      result: "rejected",
      message: "Zone 1 lies on no conveyor",
    });
  });

  it("waits while the application does not allow taking a set over", async () => {
    const { last, cycle, gateway, emulation } = setup();
    await cycle();
    emulation!.applyAllowed = false;
    const set = component(last("parameters"), 1)!.set;
    await gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId: 1, baseVersion: 0, set });
    await cycle();
    expect(component(last("parameters"), 1)).toMatchObject({ activeVersion: 0, result: "pending" });

    emulation!.applyAllowed = true;
    await cycle();
    expect(component(last("parameters"), 1)).toMatchObject({ activeVersion: 1, result: "applied" });
  });

  it("drops a set still waiting for the application when a reset comes", async () => {
    const { last, cycle, gateway, emulation } = setup();
    await cycle();
    emulation!.applyAllowed = false;
    const set = structuredClone(component(last("parameters"), 1)!.set);
    if (set.type !== "conveyor") throw new Error("not a conveyor");
    set.parameters.pose.x = 500;
    await gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId: 1, baseVersion: 0, set });
    await cycle();
    await gateway.command({ kind: "resetParameters", requestId: 2, sourceId: "plc1", componentId: 1, baseVersion: 0 });
    emulation!.applyAllowed = true;
    await cycle();
    await cycle();
    expect(component(last("parameters"), 1)).toMatchObject({ activeVersion: 0, set: { parameters: { pose: { x: 0 } } } });
  });

  it("returns a component to its program values on a reset", async () => {
    const { last, cycle, gateway } = setup();
    await cycle();
    const set = structuredClone(component(last("parameters"), 1)!.set);
    if (set.type !== "conveyor") throw new Error("not a conveyor");
    set.parameters.pose.x = 500;
    await gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId: 1, baseVersion: 0, set });
    await cycle();
    expect(component(last("parameters"), 1)?.set.parameters.pose.x).toBe(500);

    expect(await gateway.command({ kind: "resetParameters", requestId: 2, sourceId: "plc1", componentId: 1, baseVersion: 1 })).toMatchObject({ ok: true });
    await cycle();
    expect(component(last("parameters"), 1)).toMatchObject({ activeVersion: 0, set: { parameters: { pose: { x: 0 } } } });
  });

  it("only reads without --allow-write, and a PLC without Syn_Config gets no parameters", async () => {
    const readOnly = setup({ allowWrite: false });
    await readOnly.cycle();
    expect(readOnly.last("parameters")).toMatchObject({ writable: false, reason: NOT_ALLOWED });
    const set = component(readOnly.last("parameters"), 1)!.set;
    expect(
      await readOnly.gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId: 1, baseVersion: 0, set }),
    ).toEqual({ ok: false, error: NOT_ALLOWED });

    const without = setup({ config: false });
    await without.cycle();
    expect(without.last("parameters")).toBeUndefined();
    expect(
      await without.gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId: 1, baseVersion: 0, set }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/no Syn_Config/) });
  });
  // Every other component type (#24): one parameter FB each, the same staging, its own parameter structure.
  const zone = { nConveyorId: 1, fStart: 500, fEnd: 900 };
  const others: [MachineComponent["kind"], MachineComponent["value"]][] = [
    ["xtsGantry", xtsGantry({ zones: [zone] })],
    ["xtsLoop", xtsLoop({ zones: [zone] })],
    ["cartesian", cartesian({ zones: [zone] })],
    ["vision", detector({ zones: [zone] })],
    ["sensor", detector({ zones: [zone] })],
    ["station", station({ zones: [zone] })],
  ];
  it.each(others)("writes the parameter set of a %s, which the application passes on", async (kind, value) => {
    const plc = new InMemoryPlc();
    defineMachine(plc, [
      { id: 1, name: "Infeed", path: "MAIN.stInfeed", kind: "conveyor", value: conveyor({ length: 3000 }) },
      { id: 20, name: "It", path: "MAIN.stIt", kind, value } as MachineComponent,
    ]);
    const emulation = new ConfigEmulation(plc, [{ id: 20, kind, path: "MAIN.fbItParam.vo_Config", visuPath: "MAIN.stIt" }]);
    const gateway = createGateway({ plc, sourceId: "plc1", allowWrite: true, now: () => 0 });
    const messages: ServerMessage[] = [];
    gateway.subscribe((m) => messages.push(ServerMessageSchema.parse(JSON.parse(JSON.stringify(m)))));
    const lastOf = (k: "parameters" | "config") => messages.filter((m) => m.kind === k).at(-1);
    const cycle = async () => {
      emulation.step();
      await gateway.cycle();
    };
    await cycle();
    const before = component(lastOf("parameters") as ParametersMessage, 20)!;
    expect(before).toMatchObject({ activeVersion: 0, set: { type: kind, parameters: { zones: [{ conveyorId: 1, start: 500, end: 900 }] } } });

    const set = structuredClone(before.set);
    const p = set.parameters as Record<string, unknown> & { pose: { x: number }; zones: { end: number }[] };
    p.pose.x += 250;
    p.zones[0]!.end = 1200;
    p.originShift = { x: 10, y: 20, z: 30 };
    if ("modules" in p) p.modules = [...(p.modules as unknown[]), { kind: "curveLeft", length: 250 }];
    if ("tcpLimitArea" in p) p.tcpLimitArea = { xMin: -60, xMax: 60, yMin: -60, yMax: 60, zMin: -100, zMax: 20 };
    if ("limitArea" in p) p.limitArea = { xMin: 0, xMax: 600, yMin: -100, yMax: 1500, zMin: -500, zMax: -100 };
    const result = await gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId: 20, baseVersion: 0, set });
    expect(result).toMatchObject({ ok: true });

    await cycle();
    expect(component(lastOf("parameters") as ParametersMessage, 20)).toMatchObject({ activeVersion: 1, result: "applied", set });
    const shown = (lastOf("config") as ConfigMessage).components.find((c) => c.id === 20);
    expect(shown).toMatchObject(set.parameters);
  });

  it("removes a robot's limit area and TCP limit area: the visualisation shows none", async () => {
    const plc = new InMemoryPlc();
    const box = { fXMin: 0, fXMax: 1000, fYMin: 0, fYMax: 800, fZMin: -600, fZMax: -100 };
    defineMachine(plc, [{ id: 40, name: "Cartesian", path: "MAIN.stCart", kind: "cartesian", value: cartesian({ limitArea: box, tcpLimitArea: box }) }]);
    const emulation = new ConfigEmulation(plc, [{ id: 40, kind: "cartesian", path: "MAIN.fbCartParam.vo_Config", visuPath: "MAIN.stCart" }]);
    const gateway = createGateway({ plc, sourceId: "plc1", allowWrite: true, now: () => 0 });
    let parameters: ParametersMessage | undefined;
    let config: ConfigMessage | undefined;
    gateway.subscribe((m) => {
      if (m.kind === "parameters") parameters = m;
      if (m.kind === "config") config = m;
    });
    emulation.step();
    await gateway.cycle();
    expect(config?.components[0]).toMatchObject({ limitArea: { xMax: 1000 }, tcpLimitArea: { yMax: 800 } });

    const set = structuredClone(component(parameters, 40)!.set);
    if (set.type !== "cartesian") throw new Error("not a Cartesian robot");
    set.parameters.limitArea = null;
    set.parameters.tcpLimitArea = null;
    await gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId: 40, baseVersion: 0, set });
    emulation.step();
    await gateway.cycle();

    expect(component(parameters, 40)).toMatchObject({ activeVersion: 1, result: "applied", set });
    expect(config?.components[0]).toMatchObject({ limitArea: null, tcpLimitArea: null });
  });

  it("rejects an XTS track without modules or with a module without a length", async () => {
    const plc = new InMemoryPlc();
    defineMachine(plc, [{ id: 20, name: "Fxx", path: "MAIN.stFxx", kind: "xtsLoop", value: xtsLoop() }]);
    const emulation = new ConfigEmulation(plc, [{ id: 20, kind: "xtsLoop", path: "MAIN.fbFxxParam.vo_Config", visuPath: "MAIN.stFxx" }]);
    const gateway = createGateway({ plc, sourceId: "plc1", allowWrite: true, now: () => 0 });
    let parameters: ParametersMessage | undefined;
    gateway.subscribe((m) => {
      if (m.kind === "parameters") parameters = m;
    });
    const cycle = async () => {
      emulation.step();
      await gateway.cycle();
    };
    await cycle();
    const write = async (change: (modules: { kind: string; length: number }[]) => unknown[]) => {
      const set = structuredClone(component(parameters, 20)!.set);
      if (set.type !== "xtsLoop") throw new Error("not an XTS loop");
      set.parameters.modules = change(set.parameters.modules) as typeof set.parameters.modules;
      await gateway.command({ kind: "writeParameters", requestId: 1, sourceId: "plc1", componentId: 20, baseVersion: 0, set });
      await cycle();
      return component(parameters, 20);
    };

    expect(await write((m) => m.map((x, i) => (i === 1 ? { ...x, length: 0 } : x)))).toMatchObject({
      activeVersion: 0,
      result: "rejected",
      message: "Track module 2 has no length",
    });
    expect(await write(() => [])).toMatchObject({ result: "rejected", message: "A track without modules" });
  });
});
