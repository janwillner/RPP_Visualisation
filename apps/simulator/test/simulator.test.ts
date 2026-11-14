import { describe, expect, it } from "vitest";
import { RECIPE_FILE_FORMAT, RecipeFileSchema, type RunState } from "@rpp/protocol";
import { A, B, FakeLive, RECIPE, infeed, message, simulator } from "./fake-live";
import { RECIPE_FILE_EXTENSION, Simulator } from "../src/simulator";

describe("Simulator: source and recipe form", () => {
  it("shows the recipe of the first source that has one, grouped by its components in the fields' order", () => {
    const live = new FakeLive();
    live.plc(B, [infeed(1)], "Other PLC");
    const { sim } = simulator(live);

    const s = sim.getSnapshot();
    expect(s.sourceId).toBe(A);
    expect(s.form.map((g) => [g.name, g.fields.map((f) => f.field.name)])).toEqual([
      ["Infeed 1", ["BeltSpeed"]],
      ["Delta 1", ["RobotSpeed", "PicksPerCycle"]],
      ["Machine", ["Rate", "TypeMix", "Feed"]],
    ]);
    const belt = s.form[0]!.fields[0]!;
    expect(belt).toMatchObject({ label: "Belt speed", value: 150, active: 150, changed: false });
    expect(belt.error).toBeUndefined();
  });

  it("switches to another source and keeps each source's edits", () => {
    const { live, sim } = simulator();
    live.plc(B, [infeed(1)], "Other PLC");
    live.recipe(B);
    sim.edit("Rate", 90);

    sim.selectSource(B);
    expect(sim.getSnapshot().sourceId).toBe(B);
    expect(sim.field("Rate")?.value).toBe(60);
    sim.selectSource(A);
    expect(sim.field("Rate")).toMatchObject({ value: 90, changed: true });
  });

  it("starts before the gateway reports any source, and shows the first one once it does", () => {
    const live = new FakeLive();
    const sim = new Simulator(live, () => true);
    sim.start();
    expect(sim.getSnapshot()).toMatchObject({ sourceId: undefined, form: [], blocked: "The gateway reads no PLC." });
    live.plc(A, [infeed(1)]);
    live.machine(A);
    live.recipe(A);
    expect(sim.getSnapshot().sourceId).toBe(A);
    expect(sim.getSnapshot().form).not.toEqual([]);
  });

  it("has no form for a source without a recipe", () => {
    const live = new FakeLive();
    live.plc(A, [infeed(1)]);
    const sim = new Simulator(live, () => true);
    sim.start();
    expect(sim.getSnapshot().sourceId).toBe(A);
    expect(sim.getSnapshot().form).toEqual([]);
    expect(sim.writePlan().blocked).toMatch(/machine FB/);
  });
});

describe("Simulator: editing", () => {
  it("marks a changed field, and an edit back to the active value is no change", () => {
    const { sim } = simulator();
    sim.edit("BeltSpeed", 200);
    expect(sim.field("BeltSpeed")).toMatchObject({ value: 200, active: 150, changed: true });
    sim.edit("BeltSpeed", 150);
    expect(sim.field("BeltSpeed")?.changed).toBe(false);
    expect(sim.writePlan().changes).toEqual([]);
  });

  it.each([
    ["BeltSpeed", 5, /BeltSpeed must be a number from 10 to 500/],
    ["PicksPerCycle", 1.5, /whole number from 1 to 2/],
    ["TypeMix", 3, /one of its choices/],
    ["Feed", 1, /true or false/],
  ])("gives %s = %s an error and lists it as a problem", (name, value, error) => {
    const { sim } = simulator();
    sim.edit(name, value);
    expect(sim.field(name)?.error).toMatch(error);
    expect(sim.getSnapshot().problems).toEqual([expect.objectContaining({ severity: "error", text: expect.stringMatching(error) })]);
    expect(sim.writePlan().blocked).toMatch(/Fix/);
  });

  it("discards the edits of the source shown", () => {
    const { sim } = simulator();
    sim.edit("Rate", 90);
    sim.discardEdits();
    expect(sim.field("Rate")).toMatchObject({ value: 60, changed: false });
  });
});

describe("Simulator: writing the recipe", () => {
  it("plans the changed fields with their old and new values", () => {
    const { sim } = simulator();
    sim.edit("Rate", 90);
    sim.edit("Feed", false);
    expect(sim.writePlan()).toEqual({
      changes: [
        { name: "Rate", label: "Rate", from: "60 1/min", to: "90 1/min" },
        { name: "Feed", label: "Feed", from: "on", to: "off" },
      ],
    });
  });

  it.each([
    ["no write allowed", (live: FakeLive) => live.recipe(A, {}, { writable: false, reason: "The gateway does not allow writing." }), /does not allow writing/],
    ["no simulation mode", (live: FakeLive) => live.machine(A, { simulation: false }), /simulation mode/],
    ["no machine entry", (live: FakeLive) => live.plc(A, [infeed(1)]), /simulation mode/],
    ["an offline PLC", (live: FakeLive) => live.send({ kind: "status", sourceId: A, sourceName: "Line PLC", status: { plcConnected: false } }), /not connected/],
  ])("is blocked with %s", (_, given, reason) => {
    const { live, sim } = simulator();
    given(live);
    sim.edit("Rate", 90);
    expect(sim.writePlan().blocked).toMatch(reason);
  });

  it("writes only the changed values on the active version and follows the write until the PLC applied it", async () => {
    const { live, sim } = simulator();
    live.recipe(A, { activeVersion: 4, values: { ...RECIPE.values } });
    sim.edit("Rate", 90);
    sim.edit("BeltSpeed", 150);

    await sim.write();
    expect(live.commands).toEqual([expect.objectContaining({ kind: "writeRecipe", sourceId: A, baseVersion: 4, values: { Rate: 90 } })]);
    const stageId = 101;
    expect(sim.getSnapshot().write).toEqual({ kind: "write", state: "staged", stageId });

    live.recipe(A, { activeVersion: 4, result: "pending" });
    expect(sim.getSnapshot().write?.state).toBe("waiting");

    live.recipe(A, { activeVersion: 5, handledStageId: stageId, result: "applied", values: { ...RECIPE.values, Rate: 90 } });
    expect(sim.getSnapshot().write).toEqual({ kind: "write", state: "applied", stageId });
    expect(sim.field("Rate")).toMatchObject({ value: 90, active: 90, changed: false });
    expect(sim.getSnapshot().saved).toBe(true);
  });

  it("keeps the edits when the PLC rejects the recipe, and tells why", async () => {
    const { live, sim } = simulator();
    sim.edit("Rate", 90);
    await sim.write();
    live.recipe(A, { handledStageId: 101, result: "rejected", message: "Not while running" });
    expect(sim.getSnapshot().write).toMatchObject({ state: "rejected", message: "Not while running" });
    expect(sim.field("Rate")?.changed).toBe(true);
  });

  it("reports a write the gateway refused", async () => {
    const { live, sim } = simulator();
    live.answer = () => ({ ok: false, error: "The active recipe changed." });
    sim.edit("Rate", 90);
    await sim.write();
    expect(sim.getSnapshot().write).toEqual({ kind: "write", state: "failed", message: "The active recipe changed." });
  });

  it("sends nothing while blocked or without changes", async () => {
    const { live, sim } = simulator();
    await sim.write();
    live.machine(A, { simulation: false });
    sim.edit("Rate", 90);
    await sim.write();
    expect(live.commands).toEqual([]);
  });

  it("returns the machine to its program values and follows it like a write", async () => {
    const { live, sim } = simulator();
    live.recipe(A, { activeVersion: 3 });
    await sim.resetRecipe();
    expect(live.commands).toEqual([expect.objectContaining({ kind: "resetRecipe", sourceId: A, baseVersion: 3 })]);
    live.recipe(A, { activeVersion: 0, handledStageId: 101, result: "applied" });
    expect(sim.getSnapshot().write).toEqual({ kind: "reset", state: "applied", stageId: 101 });
  });
});

describe("Simulator: machine commands", () => {
  const cases: [RunState, { start: boolean; stop: boolean; reset: boolean }][] = [
    ["stopped", { start: true, stop: false, reset: true }],
    ["starting", { start: false, stop: true, reset: false }],
    ["running", { start: false, stop: true, reset: false }],
    ["stopping", { start: false, stop: false, reset: false }],
    ["fault", { start: false, stop: false, reset: true }],
  ];

  it.each(cases)("while %s enables %o", (runState, enabled) => {
    const { live, sim } = simulator();
    live.machine(A, { runState });
    const c = sim.getSnapshot().commands;
    expect({ start: c.start.enabled, stop: c.stop.enabled, reset: c.reset.enabled }).toEqual(enabled);
    for (const kind of ["start", "stop", "reset"] as const) {
      if (!c[kind].enabled) expect(c[kind].reason, kind).toBeTruthy();
    }
  });

  it.each(cases)("while %s enables nothing without simulation mode, without write access or without a machine FB", (runState) => {
    for (const given of [
      (live: FakeLive) => live.machine(A, { runState, simulation: false }),
      (live: FakeLive) => {
        live.machine(A, { runState });
        live.recipe(A, {}, { writable: false, reason: "The gateway does not allow writing." });
      },
      (live: FakeLive) => {
        live.machine(A, { runState });
        // Config protocol 2: parameter sets, but no machine FB and so no recipe.
        live.send({ kind: "parameters", sourceId: A, writable: true, components: [] });
      },
    ]) {
      const { live, sim } = simulator();
      given(live);
      const c = sim.getSnapshot().commands;
      expect([c.start.enabled, c.stop.enabled, c.reset.enabled]).toEqual([false, false, false]);
      expect(c.start.reason).toMatch(/simulation mode|allow writing|machine FB/);
    }
  });

  it("sends a command and shows the application's answer", async () => {
    const { live, sim } = simulator();
    await sim.command("start");
    expect(live.commands).toEqual([expect.objectContaining({ kind: "machineCommand", sourceId: A, command: "start" })]);
    expect(sim.getSnapshot().command).toEqual({ command: "start", state: "sent", commandId: 101 });

    live.recipe(A, {}, { machineCommand: { handledCommandId: 101, result: "rejected", message: "Doors open" } });
    expect(sim.getSnapshot().command).toEqual({ command: "start", state: "rejected", commandId: 101, message: "Doors open" });

    await sim.command("start");
    live.recipe(A, {}, { machineCommand: { handledCommandId: 102, result: "accepted", message: "" } });
    expect(sim.getSnapshot().command).toMatchObject({ command: "start", state: "accepted" });
  });

  it("sends no command that is not enabled, and reports one the gateway refused", async () => {
    const { live, sim } = simulator();
    await sim.command("stop");
    expect(live.commands).toEqual([]);
    live.answer = () => ({ ok: false, error: "Not connected to the gateway." });
    await sim.command("start");
    expect(sim.getSnapshot().command).toEqual({ command: "start", state: "failed", message: "Not connected to the gateway." });
  });
});

describe("Simulator: machine messages and faults", () => {
  it("lists the active machine messages, errors first, and the component faults; an entry selects its component", () => {
    const { live, sim } = simulator();
    live.machine(A, {
      messages: [
        message({ id: 1, text: "Reject bin almost full", componentId: 1 }),
        message({ id: 2, text: "Emergency stop", severity: "error" }),
        message({ id: 3, text: "Gone", active: false }),
      ],
    });
    sim.setFaults([{ sourceId: A, componentId: 10, messages: ["Gripper lost vacuum"], limitViolations: [] }]);

    const entries = sim.getSnapshot().messages;
    expect(entries.map((e) => [e.severity, e.text])).toEqual([
      ["error", "Line PLC: Emergency stop"],
      ["warning", "Infeed 1: Reject bin almost full"],
      ["error", "Delta 1: Gripper lost vacuum"],
    ]);
    sim.select(entries[1]!.selection);
    expect(sim.getSnapshot().selection).toEqual({ kind: "component", sourceId: A, id: 1 });
    expect(entries[0]!.selection).toBeUndefined();
  });
});

describe("Simulator: recipe file", () => {
  it("saves every source's values by group and field name", () => {
    const { sim } = simulator();
    sim.edit("Rate", 90);
    sim.rename("Fast feed");
    const file = sim.save();
    expect(file.name).toBe(`Fast feed${RECIPE_FILE_EXTENSION}`);
    const saved = RecipeFileSchema.parse(JSON.parse(file.text));
    expect(saved).toEqual({
      format: RECIPE_FILE_FORMAT,
      formatVersion: 1,
      name: "Fast feed",
      sources: [
        {
          sourceId: A,
          sourceName: "Line PLC",
          values: {
            "1": { BeltSpeed: 150 },
            "10": { RobotSpeed: 100, PicksPerCycle: 2 },
            "0": { Rate: 90, TypeMix: 0, Feed: true },
          },
        },
      ],
    });
    expect(sim.getSnapshot().saved).toBe(true);
  });

  it("opens a file: changed values become edits, missing fields keep their value, unknown fields are skipped", () => {
    const { sim } = simulator();
    const { text } = sim.save();
    const file = JSON.parse(text);
    file.name = "Slow";
    file.sources[0].values = { "1": { BeltSpeed: 80 }, "0": { Rate: 60, Speed: 3 }, "10": { RobotSpeed: 50 }, "99": { Lanes: 2 } };
    file.sources[0].values["1"].RobotSpeed = 40; // saved for another group: the field's own wins, with a warning

    sim.open(JSON.stringify(file));
    const s = sim.getSnapshot();
    expect(s.name).toBe("Slow");
    expect(sim.field("BeltSpeed")).toMatchObject({ value: 80, changed: true });
    expect(sim.field("Rate")?.changed).toBe(false);
    expect(sim.field("PicksPerCycle")).toMatchObject({ value: 2, changed: false });
    expect(sim.field("RobotSpeed")).toMatchObject({ value: 50, changed: true });
    expect(sim.field("RobotSpeed")?.warning).toMatch(/Infeed 1/);
    expect(s.problems.map((p) => [p.severity, p.text])).toEqual(
      expect.arrayContaining([
        ["warning", expect.stringMatching(/Speed.*skipped/)],
        ["warning", expect.stringMatching(/Lanes.*skipped/)],
      ]),
    );
    expect(s.saved).toBe(true);
  });

  it("shows a value of the file outside its range as an error", () => {
    const { sim } = simulator();
    const file = JSON.parse(sim.save().text);
    file.sources[0].values["0"].Rate = 500;
    sim.open(JSON.stringify(file));
    expect(sim.field("Rate")?.error).toMatch(/from 1 to 120/);
  });

  it("asks before an opened file replaces edits that were not saved", () => {
    let asked = 0;
    let answer = false;
    const { sim } = simulator(new FakeLive(), () => (asked++, answer));
    const text = sim.save().text;
    sim.edit("Rate", 90);
    expect(sim.getSnapshot().saved).toBe(false);

    sim.open(text);
    expect(asked).toBe(1);
    expect(sim.field("Rate")?.value).toBe(90);
    answer = true;
    sim.open(text);
    expect(sim.field("Rate")?.value).toBe(60);
    // Nothing unsaved: no question.
    sim.open(text);
    expect(asked).toBe(2);
  });

  it("takes a file of another source when both have the only recipe", () => {
    const { sim } = simulator();
    const file = JSON.parse(sim.save().text);
    file.sources[0].sourceId = B;
    file.sources[0].values["0"].Rate = 30;
    sim.open(JSON.stringify(file));
    expect(sim.field("Rate")?.value).toBe(30);
  });

  it("refuses a file that is no recipe file", () => {
    const { sim } = simulator();
    sim.open('{"format":"rpp-draft"}');
    expect(sim.getSnapshot().notice).toMatch(/not a recipe file/i);
    sim.dismissNotice();
    expect(sim.getSnapshot().notice).toBeUndefined();
  });
});

