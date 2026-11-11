import { describe, expect, it } from "vitest";
import {
  PARAMETER_FIELDS,
  type ComponentConfig,
  type ComponentParameters,
  type ParametersMessage,
  type TypedParameters,
} from "@rpp/protocol";
import { A, connected, conveyor, delta, FakeLive } from "./fake-live";

const ZONE = { conveyorId: 1, start: 750, end: 1250, allocationOffset: 0, ccsOffset: 750, startY: 0, endY: 0 };

/** A component's parameter set as Syn_Config holds it: its parameter fields. */
function setOf(c: ComponentConfig): TypedParameters {
  const fields = PARAMETER_FIELDS[c.type as keyof typeof PARAMETER_FIELDS];
  const parameters = Object.fromEntries(fields.map((f) => [f, (c as Record<string, unknown>)[f]]));
  return { type: c.type, parameters } as TypedParameters;
}

/** The `parameters` message of a PLC whose parameter FBs give these components' values. */
function parameters(components: ComponentConfig[], status: Partial<ComponentParameters> = {}, writable = true): ParametersMessage {
  return {
    kind: "parameters",
    sourceId: A,
    writable,
    ...(writable ? {} : { reason: "The gateway does not allow writing; start it with --allow-write." }),
    components: components.map((c) => ({
      id: c.id,
      activeVersion: 0,
      handledStageId: 0,
      result: "none",
      message: "",
      set: setOf(c),
      ...status,
    })),
  };
}

/** A PLC with a conveyor and a Delta with one zone, both with Syn_Config; imported into the draft. */
function line() {
  const live = new FakeLive();
  const robot = { ...delta(2), zones: [ZONE] } as ComponentConfig;
  live.plc(A, [conveyor(1), robot]);
  live.send(parameters([conveyor(1), robot]));
  const c = connected(live);
  c.importSource(A);
  return { live, c, robot };
}

describe("Configurator writing to a PLC (ADR 0017)", () => {
  it("plans a write as the parameter values that change, component by component; hardware is not among them", () => {
    const { c } = line();
    c.set(`${A}#2`, ["zones", "0", "end"], 1400);
    c.set(`${A}#2`, ["upperArmLength"], 450);
    c.set(`${A}#1`, ["pose", "y"], 30);

    expect(c.writePlan(A)).toEqual({
      changes: [
        { key: `${A}#1`, name: "Belt 1", fields: [{ path: "pose.y", from: "0", to: "30" }] },
        { key: `${A}#2`, name: "Delta 2", fields: [{ path: "zones.1.end", from: "1250", to: "1400" }] },
      ],
    });
  });

  it("does not write to a PLC without Syn_Config, without --allow-write, or while the draft has errors there", () => {
    const { c, live, robot } = line();
    live.send(parameters([conveyor(1), robot], {}, false));
    expect(c.writePlan(A).blocked).toBe("The gateway does not allow writing; start it with --allow-write.");

    const other = new FakeLive();
    other.plc(A, [conveyor(1)]);
    const d = connected(other);
    d.importSource(A);
    expect(d.writePlan(A).blocked).toMatch(/no Syn_Config/);

    live.send(parameters([conveyor(1), robot]));
    c.set(`${A}#2`, ["zones", "0", "conveyorId"], 9);
    expect(c.writePlan(A).blocked).toBe("Fix the errors of this PLC's components first: Delta 2: zone 1 lies on conveyor 9, which source ads:5.1.2.3.1.1:851 does not have");
  });

  it("writes every changed component on the active version it is based on, and follows each until the PLC handled it", async () => {
    const { c, live, robot } = line();
    c.set(`${A}#2`, ["zones", "0", "end"], 1400);
    c.set(`${A}#1`, ["pose", "y"], 30);

    await c.write(A);
    expect(live.commands).toEqual([
      expect.objectContaining({ kind: "writeParameters", sourceId: A, componentId: 1, baseVersion: 0, set: setOf(c.getSnapshot().draft.components[0]!) }),
      expect.objectContaining({ kind: "writeParameters", sourceId: A, componentId: 2, baseVersion: 0, set: setOf(c.getSnapshot().draft.components[1]!) }),
    ]);
    expect(c.getSnapshot().writes).toEqual({ [`${A}#1`]: { state: "staged", stageId: 101 }, [`${A}#2`]: { state: "staged", stageId: 102 } });

    // The PLC takes the belt's over and rejects the Delta's.
    const belt = { ...conveyor(1), pose: { ...conveyor(1).pose, y: 30 } };
    live.send({
      ...parameters([belt, robot]),
      components: [
        { ...parameters([belt]).components[0]!, activeVersion: 1, handledStageId: 101, result: "applied" },
        { ...parameters([robot]).components[0]!, handledStageId: 102, result: "rejected", message: "Zone too long" },
      ],
    });
    expect(c.getSnapshot().writes).toEqual({
      [`${A}#1`]: { state: "applied", stageId: 101 },
      [`${A}#2`]: { state: "rejected", stageId: 102, message: "Zone too long" },
    });
  });

  it("tells when a staged set waits for the application, and when the gateway refuses a write", async () => {
    const { c, live, robot } = line();
    c.set(`${A}#2`, ["zones", "0", "end"], 1400);
    await c.write(A);
    live.send(parameters([conveyor(1), robot], { result: "pending" }));
    expect(c.getSnapshot().writes[`${A}#2`]).toEqual({ state: "waiting", stageId: 101 });

    live.answer = () => ({ ok: false, error: "Component 2 has parameter version 3 active, not 0: reconcile again before writing." });
    await c.write(A);
    expect(c.getSnapshot().writes[`${A}#2`]).toEqual({
      state: "failed",
      message: "Component 2 has parameter version 3 active, not 0: reconcile again before writing.",
    });
  });

  it("returns a component to its program values", async () => {
    const { c, live, robot } = line();
    live.send(parameters([conveyor(1), robot], { activeVersion: 4 }));
    await c.resetParameters(`${A}#2`);
    expect(live.commands).toEqual([expect.objectContaining({ kind: "resetParameters", sourceId: A, componentId: 2, baseVersion: 4 })]);
  });

  it("warns when the visualisation shows other values than the active parameter set: the application does not pass them on", () => {
    const { c, live, robot } = line();
    const moved = { ...robot, pose: { ...robot.pose, x: 1600 } } as ComponentConfig;
    live.send(parameters([conveyor(1), moved], { activeVersion: 1 }));
    expect(c.getSnapshot().issues).toContainEqual({
      severity: "warning",
      key: `${A}#2`,
      message: "Delta 2: the visualisation shows other values than the active parameter set (pose); does the application pass them on to Syn_Visu?",
    });
  });
});
