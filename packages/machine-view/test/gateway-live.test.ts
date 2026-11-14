import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type ComponentParameters,
  type ParametersMessage,
  type Recipe,
  type TypedParameters,
} from "@rpp/protocol";
import { GatewayLive, writeKey } from "../src/gateway-live";
import { componentKey } from "../src/scene/scene-model";
import { FakeConnection } from "../src/testing";

const A = "ads:5.1.2.3.1.1:851";
const SET = { type: "conveyor", parameters: {} } as unknown as TypedParameters;
const RECIPE: Recipe = { fields: [], activeVersion: 0, handledStageId: 0, result: "none", message: "", values: {} };

const parameters = (more: Partial<ParametersMessage> = {}): ParametersMessage => ({
  kind: "parameters",
  sourceId: A,
  writable: true,
  components: [],
  ...more,
});
const component = (more: Partial<ComponentParameters> = {}): ComponentParameters => ({
  id: 1,
  activeVersion: 0,
  handledStageId: 0,
  result: "none",
  message: "",
  set: SET,
  ...more,
});

function setup() {
  const connection = new FakeConnection();
  const live = new GatewayLive(connection);
  return { connection, live, writes: () => live.getSnapshot().writes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GatewayLive: a write followed until the PLC handled it", () => {
  it("stages a parameter set, keyed by its component, and follows it through waiting until the PLC applied it", async () => {
    const { connection, live, writes } = setup();
    connection.deliver(parameters({ components: [component()] }));

    const staged = await live.stage({ kind: "writeParameters", sourceId: A, componentId: 1, baseVersion: 0, set: SET });
    expect(staged).toEqual({ kind: "writeParameters", state: "staged", stageId: 101 });
    expect(connection.sent).toEqual([expect.objectContaining({ kind: "writeParameters", sourceId: A, componentId: 1 })]);
    const key = writeKey({ kind: "writeParameters", sourceId: A, componentId: 1 });
    expect(key).toBe(componentKey(A, 1));
    expect(writes()[key]).toEqual(staged);

    connection.deliver(parameters({ components: [component({ result: "pending" })] }));
    expect(writes()[key]?.state).toBe("waiting");
    connection.deliver(parameters({ components: [component({ activeVersion: 1, handledStageId: 101, result: "applied" })] }));
    expect(writes()[key]).toEqual({ kind: "writeParameters", state: "applied", stageId: 101 });
  });

  it("follows a recipe write and a reset under one key per source, and tells why the PLC rejected one", async () => {
    const { connection, live, writes } = setup();
    connection.deliver(parameters({ recipe: RECIPE }));
    const key = writeKey({ kind: "writeRecipe", sourceId: A });
    expect(writeKey({ kind: "resetRecipe", sourceId: A })).toBe(key);

    await live.stage({ kind: "writeRecipe", sourceId: A, baseVersion: 0, values: { Rate: 500 } });
    connection.deliver(parameters({ recipe: { ...RECIPE, handledStageId: 101, result: "rejected", message: "Field Rate: 500 is outside 1 to 120" } }));
    expect(writes()[key]).toEqual({ kind: "writeRecipe", state: "rejected", stageId: 101, message: "Field Rate: 500 is outside 1 to 120" });

    await live.stage({ kind: "resetRecipe", sourceId: A, baseVersion: 0 });
    expect(writes()[key]).toEqual({ kind: "resetRecipe", state: "staged", stageId: 102 });
  });

  it("follows a machine command until the application accepted or rejected it", async () => {
    const { connection, live, writes } = setup();
    connection.deliver(parameters({ recipe: RECIPE, machineCommand: { handledCommandId: 0, result: "none", message: "" } }));
    const key = writeKey({ kind: "machineCommand", sourceId: A });

    await live.stage({ kind: "machineCommand", sourceId: A, command: "start" });
    connection.deliver(parameters({ recipe: RECIPE, machineCommand: { handledCommandId: 101, result: "accepted", message: "" } }));
    expect(writes()[key]).toEqual({ kind: "machineCommand", state: "applied", stageId: 101 });

    await live.stage({ kind: "machineCommand", sourceId: A, command: "reset" });
    connection.deliver(
      parameters({ recipe: RECIPE, machineCommand: { handledCommandId: 102, result: "rejected", message: "Stop the machine first" } }),
    );
    expect(writes()[key]).toEqual({ kind: "machineCommand", state: "rejected", stageId: 102, message: "Stop the machine first" });
  });

  it("takes a write the PLC handled before the gateway's answer arrived as handled at once", async () => {
    const { connection, live, writes } = setup();
    connection.answer = () => {
      // The PLC is quicker than the answer: its status comes first.
      queueMicrotask(() => connection.deliver(parameters({ components: [component({ handledStageId: 101, result: "applied" })] })));
      return { ok: true, stageId: 101 };
    };
    expect(await live.stage({ kind: "resetParameters", sourceId: A, componentId: 1, baseVersion: 1 })).toMatchObject({ state: "applied" });
    expect(writes()[componentKey(A, 1)]?.state).toBe("applied");
  });
});

describe("GatewayLive: a write that fails", () => {
  it("fails a write the gateway refuses, with its reason", async () => {
    const { connection, live } = setup();
    connection.answer = () => ({ ok: false, error: "The gateway does not allow writing; start it with --allow-write." });
    expect(await live.stage({ kind: "writeRecipe", sourceId: A, baseVersion: 0, values: {} })).toEqual({
      kind: "writeRecipe",
      state: "failed",
      message: "The gateway does not allow writing; start it with --allow-write.",
    });
  });

  it("fails a write the gateway does not answer within 10 s", async () => {
    vi.useFakeTimers();
    const { connection, live } = setup();
    connection.answer = () => undefined;
    const staged = live.stage({ kind: "machineCommand", sourceId: A, command: "stop" });
    vi.advanceTimersByTime(10_000);
    expect(await staged).toMatchObject({ state: "failed", message: expect.stringMatching(/did not answer/) });
  });

  it("fails a write while not connected to the gateway, and sends nothing", async () => {
    const { connection, live } = setup();
    connection.setSocket("closed");
    expect(await live.stage({ kind: "machineCommand", sourceId: A, command: "start" })).toMatchObject({
      state: "failed",
      message: expect.stringMatching(/Not connected/),
    });
    expect(connection.sent).toEqual([]);
  });

  it("fails what is still staged when the connection is lost, and forgets the parameter sets", async () => {
    const { connection, live, writes } = setup();
    connection.deliver(parameters({ components: [component()] }));
    await live.stage({ kind: "writeParameters", sourceId: A, componentId: 1, baseVersion: 0, set: SET });

    connection.setSocket("closed");
    expect(writes()[componentKey(A, 1)]).toMatchObject({ state: "failed", message: expect.stringMatching(/connection to the gateway was lost/) });
    expect(live.getSnapshot().parameters).toEqual({});
  });

  it("forgets a source's parameter sets when its configuration comes again", () => {
    const { connection, live } = setup();
    connection.deliver(parameters());
    connection.deliver({ kind: "config", sourceId: A, protocolVersion: PROTOCOL_VERSION, configVersion: 2, errors: [], marks: [], components: [] });
    expect(live.getSnapshot().parameters).toEqual({});
  });
});
