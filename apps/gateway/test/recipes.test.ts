import { describe, expect, it } from "vitest";
import { ServerMessageSchema, type ClientMessage, type ServerMessage } from "@rpp/protocol";
import { ConfigEmulation, recipeField } from "../src/config-emulation";
import { E_ConfigFieldType, type ST_ConfigMachine } from "../src/config-contract";
import { createGateway, type GatewayCommandResult } from "../src/gateway";
import { InMemoryPlc } from "../src/in-memory-plc";
import { NOT_ALLOWED } from "../src/parameter-access";
import { conveyor, defineMachine, defineMachineEntry } from "../src/plc-builders";
import type { SymbolWrite } from "../src/symbol-access";

const MACHINE_FB = "MAIN.fbMachineParam.vo_Config";

/** A command as a test sends it: source and request id are filled in. */
type Command = ClientMessage extends infer C ? (C extends ClientMessage ? Omit<C, "requestId" | "sourceId"> : never) : never;

/**
 * A PLC with a conveyor (1) whose application declares a recipe through Syn_Config's machine FB: the belt speed on the
 * conveyor, a whole number of picks, a switch and a choice for the whole machine. It reports simulation mode unless
 * told otherwise.
 */
function setup(options: { allowWrite?: boolean; simulation?: boolean | undefined; configProtocol?: number; machineFb?: boolean } = {}) {
  const plc = new InMemoryPlc();
  defineMachine(plc, [{ id: 1, name: "Infeed", path: "MAIN.stInfeed", kind: "conveyor", value: conveyor() }]);
  if (options.simulation !== undefined || !("simulation" in options)) defineMachineEntry(plc, { bSimulation: options.simulation ?? true });
  const emulation = new ConfigEmulation(plc, [{ id: 1, kind: "conveyor", path: "MAIN.fbInfeedParam.vo_Config", visuPath: "MAIN.stInfeed" }], {
    ...(options.configProtocol !== undefined ? { protocolVersion: options.configProtocol } : {}),
    ...(options.machineFb === false
      ? {}
      : {
          machine: {
            path: MACHINE_FB,
            fields: [
              recipeField({ sName: "BeltSpeed", nGroup: 1, sUnit: "mm/s", fMin: 0, fMax: 500, fProgramValue: 150 }),
              recipeField({ sName: "PicksPerCycle", eType: E_ConfigFieldType.INTEGER, fMin: 1, fMax: 4, fProgramValue: 1 }),
              recipeField({ sName: "Feed", eType: E_ConfigFieldType.SWITCH, fProgramValue: 1 }),
              recipeField({ sName: "Pattern", eType: E_ConfigFieldType.CHOICE, choices: ["Lanes", "Random", "Gaps"], fProgramValue: 0 }),
            ],
          },
        }),
  });
  const gateway = createGateway({ plc, sourceId: "plc1", allowWrite: options.allowWrite ?? true, now: () => 0 });
  const messages: ServerMessage[] = [];
  gateway.subscribe((m) => messages.push(ServerMessageSchema.parse(JSON.parse(JSON.stringify(m)))));
  const parameters = () => messages.filter((m) => m.kind === "parameters").at(-1);
  const writes: SymbolWrite[][] = [];
  const sumWrite = plc.sumWrite.bind(plc);
  plc.sumWrite = async (w) => {
    writes.push([...w]);
    return sumWrite(w);
  };
  const cycle = async () => {
    emulation.step();
    await gateway.cycle();
  };
  const send = (command: Command): Promise<GatewayCommandResult> =>
    gateway.command({ requestId: 1, sourceId: "plc1", ...command } as ClientMessage);
  return { plc, emulation, gateway, messages, parameters, writes, cycle, send };
}

describe("recipe fields and machine commands (Syn_Config config protocol 3, ADR 0022)", () => {
  it("publishes the declared fields, the recipe's status and the program values while no recipe is active", async () => {
    const { parameters, cycle } = setup();
    await cycle();

    const message = parameters();
    expect(message?.kind === "parameters" && message.recipe).toEqual({
      fields: [
        { name: "BeltSpeed", group: 1, type: "number", unit: "mm/s", min: 0, max: 500, programValue: 150, choices: [] },
        { name: "PicksPerCycle", group: 0, type: "integer", unit: "", min: 1, max: 4, programValue: 1, choices: [] },
        { name: "Feed", group: 0, type: "switch", unit: "", min: 0, max: 0, programValue: 1, choices: [] },
        { name: "Pattern", group: 0, type: "choice", unit: "", min: 0, max: 0, programValue: 0, choices: ["Lanes", "Random", "Gaps"] },
      ],
      activeVersion: 0,
      handledStageId: 0,
      result: "none",
      message: "",
      values: { BeltSpeed: 150, PicksPerCycle: 1, Feed: true, Pattern: 0 },
    });
    expect(message?.kind === "parameters" && message.machineCommand).toEqual({ handledCommandId: 0, result: "none", message: "" });
  });

  it("stages a recipe in one sum-write, the trigger last; a field left out keeps its value; reset returns to the program", async () => {
    const { parameters, cycle, send, writes } = setup();
    await cycle();

    const written = await send({ kind: "writeRecipe", baseVersion: 0, values: { BeltSpeed: 220, Feed: false } });
    expect(written).toEqual({ ok: true, stageId: expect.any(Number) });
    const paths = writes[0]!.map((w) => w.path);
    expect(paths.at(-1)).toBe(`${MACHINE_FB}.stStaging.bStaged`);
    expect(writes[0]!.at(-1)!.value).toBe(true);
    expect(writes[0]!.filter((w) => w.path.startsWith(`${MACHINE_FB}.aStaged[`)).map((w) => w.value)).toEqual([220, 1, 0, 0]);
    expect(paths.indexOf(`${MACHINE_FB}.stStaging.nBaseVersion`)).toBeGreaterThan(paths.indexOf(`${MACHINE_FB}.aStaged[3]`));

    await cycle();
    await cycle();
    const recipe = parameters()?.kind === "parameters" ? parameters()!.recipe : undefined;
    expect(recipe).toMatchObject({ activeVersion: 1, result: "applied", handledStageId: (written as { stageId: number }).stageId });
    expect(recipe?.values).toEqual({ BeltSpeed: 220, PicksPerCycle: 1, Feed: false, Pattern: 0 });

    expect(await send({ kind: "resetRecipe", baseVersion: 1 })).toMatchObject({ ok: true });
    expect(writes[1]!.at(-1)).toEqual({ path: `${MACHINE_FB}.stStaging.bReset`, value: true });
    await cycle();
    await cycle();
    expect(parameters()?.kind === "parameters" && parameters()!.recipe).toMatchObject({
      activeVersion: 0,
      values: { BeltSpeed: 150, Feed: true },
    });
  });

  it("asks the application to start, stop or reset, the request last; the application's answer follows", async () => {
    const { parameters, cycle, send, writes, emulation } = setup();
    await cycle();

    const started = await send({ kind: "machineCommand", command: "start" });
    expect(started).toEqual({ ok: true, stageId: expect.any(Number) });
    expect(writes[0]).toEqual([
      { path: `${MACHINE_FB}.stCommand.bRequested`, value: false },
      { path: `${MACHINE_FB}.stCommand.nCommandId`, value: (started as { stageId: number }).stageId },
      { path: `${MACHINE_FB}.stCommand.eCommand`, value: 1 },
      { path: `${MACHINE_FB}.stCommand.bRequested`, value: true },
    ]);
    await cycle();
    await cycle();
    expect(parameters()?.kind === "parameters" && parameters()!.machineCommand).toEqual({
      handledCommandId: (started as { stageId: number }).stageId,
      result: "accepted",
      message: "",
    });

    emulation.answerCommand = () => "Not stopped";
    const reset = await send({ kind: "machineCommand", command: "reset" });
    await cycle();
    await cycle();
    expect(parameters()?.kind === "parameters" && parameters()!.machineCommand).toEqual({
      handledCommandId: (reset as { stageId: number }).stageId,
      result: "rejected",
      message: "Not stopped",
    });
  });

  it.each([
    ["an unknown field", { Speed: 1 }, /no field Speed/],
    ["a value above max", { BeltSpeed: 501 }, /BeltSpeed.*0 to 500/],
    ["a value below min", { PicksPerCycle: 0 }, /PicksPerCycle.*1 to 4/],
    ["a fraction for a whole number", { PicksPerCycle: 1.5 }, /PicksPerCycle.*whole number/],
    ["a number for a switch", { Feed: 1 }, /Feed.*true or false/],
    ["a switch for a number", { BeltSpeed: true }, /BeltSpeed.*number/],
    ["a choice that does not exist", { Pattern: 3 }, /Pattern.*0 to 2/],
  ])("refuses a recipe with %s and writes nothing", async (_, values, error) => {
    const { cycle, send, writes } = setup();
    await cycle();

    const result = await send({ kind: "writeRecipe", baseVersion: 0, values: values as Record<string, number | boolean> });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(error);
    expect(writes).toEqual([]);
  });

  it("checks only the values a client sends: a field left out is written as it is, even outside its range", async () => {
    const { plc, cycle, send, writes } = setup();
    // The application's own value of Picks lies outside the range it declares.
    const machine = plc.get<ST_ConfigMachine>(MACHINE_FB);
    machine.aFields[1]!.fProgramValue = 9;
    machine.aActive[1] = 9;
    await cycle();

    expect(await send({ kind: "writeRecipe", baseVersion: 0, values: { BeltSpeed: 200 } })).toMatchObject({ ok: true });
    expect(writes[0]!.filter((w) => w.path.startsWith(`${MACHINE_FB}.aStaged[`)).map((w) => w.value)).toEqual([200, 9, 1, 0]);
  });

  it("refuses a recipe based on another active version", async () => {
    const { cycle, send, writes } = setup();
    await cycle();
    expect(await send({ kind: "writeRecipe", baseVersion: 3, values: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/version 0 active, not 3/) });
    expect(await send({ kind: "resetRecipe", baseVersion: 3 })).toMatchObject({ ok: false });
    expect(writes).toEqual([]);
  });

  it.each([
    ["the gateway does not allow writing", { allowWrite: false }, NOT_ALLOWED],
    ["the PLC is not in simulation mode", { simulation: false }, /not in simulation mode/],
    ["the PLC reports no machine entry", { simulation: undefined }, /not in simulation mode/],
    ["the application has no machine FB", { machineFb: false }, /no machine FB/],
    ["the PLC's Syn_Config is of config protocol 2", { configProtocol: 2, machineFb: false }, /config protocol 2/],
  ])("refuses recipes and machine commands when %s", async (_, options, error) => {
    const { cycle, send, writes } = setup(options);
    await cycle();

    for (const command of [
      { kind: "writeRecipe", baseVersion: 0, values: {} },
      { kind: "resetRecipe", baseVersion: 0 },
      { kind: "machineCommand", command: "stop" },
    ] as const) {
      const result = await send(command);
      expect(result.ok, command.kind).toBe(false);
      expect(!result.ok && result.error, command.kind).toMatch(error);
    }
    expect(writes).toEqual([]);
  });

  it.each([
    ["a field without a name", "", /recipe field 2 has no name/],
    ["two fields of the same name", "BeltSpeed", /BeltSpeed is declared twice/],
  ])("reports %s as a discovery error and offers no recipe", async (_, name, error) => {
    const { plc, parameters, messages, cycle, send } = setup();
    plc.get<ST_ConfigMachine>(MACHINE_FB).aFields[1]!.sName = name;
    await cycle();

    const config = messages.find((m) => m.kind === "config");
    expect(config?.kind === "config" && config.errors.map((e) => e.message).join()).toMatch(error);
    expect(parameters()?.kind === "parameters" && "recipe" in parameters()!).toBe(false);
    expect(await send({ kind: "machineCommand", command: "start" })).toMatchObject({ ok: false, error: expect.stringMatching(/no machine FB/) });
  });

  it("reads and writes a PLC of config protocol 2 as before: parameter sets, no recipe", async () => {
    const { parameters, cycle, send } = setup({ configProtocol: 2, machineFb: false });
    await cycle();

    const message = parameters();
    expect(message).toMatchObject({ writable: true, components: [{ id: 1 }] });
    expect(message?.kind === "parameters" && "recipe" in message).toBe(false);
    const set = message?.kind === "parameters" ? message.components[0]!.set : undefined;
    expect(await send({ kind: "writeParameters", componentId: 1, baseVersion: 0, set: set! })).toMatchObject({ ok: true });
  });
});
