import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ComponentConfig, type ComponentState, type GatewayMessage } from "@rpp/protocol";
import { defaultComponent } from "../src/configurator/component-defaults";
import { Configurator, ghostSourceId, type ConfiguratorLive } from "../src/configurator/configurator";
import { Sources } from "../src/sources";

const A = "ads:5.1.2.3.1.1:851";

/** The gateway as the configurator sees it: messages sent here reach it like the live ones. */
class FakeLive implements ConfiguratorLive {
  private readonly sources = new Sources();
  private readonly listeners = new Set<() => void>();
  private snapshot = { sources: this.sources.all };
  now = 0;

  send(message: GatewayMessage): void {
    this.sources.apply(this.now, message);
    if (this.snapshot.sources === this.sources.all) return;
    this.snapshot = { sources: this.sources.all };
    for (const l of this.listeners) l();
  }

  /** A connected source with these components, and one state of theirs. */
  plc(sourceId: string, components: ComponentConfig[], states: ComponentState[] = []): void {
    this.send({ kind: "status", sourceId, sourceName: "Line PLC", status: { plcConnected: true } });
    this.send({ kind: "config", sourceId, protocolVersion: PROTOCOL_VERSION, configVersion: 1, errors: [], components });
    this.send({ kind: "state", sourceId, configVersion: 1, timestamp: "0", tRel: 100, components: states });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  frame(now = this.now) {
    return this.sources.sceneSources(now);
  }
}

const conveyor = (id: number, sourceId = A, x = 0) =>
  defaultComponent("conveyor", { id, sourceId, name: `Belt ${id}` }, { x, y: 0 });
const delta = (id: number, sourceId = A, x = 1000) =>
  defaultComponent("delta", { id, sourceId, name: `Delta ${id}` }, { x, y: 0 });

/** A configurator following `live`, started. */
function connected(live: FakeLive): Configurator {
  const c = new Configurator(() => true, live);
  c.start();
  return c;
}

describe("Configurator with a PLC", () => {
  it("imports a source's configuration into the draft in place of that source's components, as one undo step", () => {
    const live = new FakeLive();
    live.plc(A, [conveyor(1), delta(2)]);
    const c = connected(live);
    c.add("conveyor", { x: 0, y: 5000 });

    c.importSource(A);
    expect(c.getSnapshot().draft.components.map((x) => `${x.sourceId}#${x.id}`)).toEqual(["draft#1", `${A}#1`, `${A}#2`]);
    expect(c.getSnapshot().draft.components[1]).toEqual(conveyor(1));

    c.set(`${A}#1`, ["length"], 2500);
    c.importSource(A);
    expect(c.getSnapshot().draft.components.find((x) => x.sourceId === A && x.id === 1)).toMatchObject({ length: 2000 });
    c.undo();
    expect(c.getSnapshot().draft.components.find((x) => x.sourceId === A && x.id === 1)).toMatchObject({ length: 2500 });
  });

  it("reconciles every component with its PLC's manifest by source, id and type, over several sources", () => {
    const B = "ads:5.1.2.4.1.1:851";
    const live = new FakeLive();
    live.plc(A, [conveyor(1), delta(2), delta(3), conveyor(4)]);
    live.plc(B, [conveyor(1, B)]);
    const c = connected(live);
    c.importSource(A);
    c.importSource(B);
    c.set(`${A}#2`, ["pose", "x"], 1200); // changed
    c.remove(`${A}#3`); // only in the PLC
    c.set(`${A}#4`, ["id"], 9); // only in the draft
    c.add("conveyor", { x: 0, y: 0 }); // no PLC for its source
    c.set(`${B}#1`, ["type"], "delta"); // another type in the PLC

    expect(c.getSnapshot().matches).toEqual({
      [`${A}#1`]: "matched",
      [`${A}#2`]: "changed",
      [`${A}#9`]: "draftOnly",
      [`${B}#1`]: "typeMismatch",
      "draft#1": "noPlc",
    });
    expect(c.getSnapshot().plcOnly.map((x) => `${x.sourceId}#${x.id}`)).toEqual([`${A}#3`, `${A}#4`]);

    c.importComponent(`${A}#3`);
    expect(c.getSnapshot().matches[`${A}#3`]).toBe("matched");
  });

  it("draws the live states of the PLC's components over the draft, and the PLC's version of a changed one as a ghost", () => {
    const live = new FakeLive();
    const tcp = { x: 1000, y: 0, z: 900 };
    const belt = { type: "conveyor" as const, id: 1, timestamp: "0", beltPosition: 0, products: [], fault: null };
    const robot = { type: "delta" as const, id: 2, timestamp: "0", actualTcp: tcp, setpointTcp: tcp, fingers: [], fault: null };
    live.plc(A, [conveyor(1), delta(2), conveyor(3)], [belt, robot]);
    live.now = 500;
    const c = connected(live);
    c.importSource(A);
    c.set(`${A}#2`, ["pose", "x"], 1200);
    c.set(`${A}#3`, ["id"], 7); // only in the draft: no state of its own
    c.add("conveyor", { x: 0, y: 0 });

    const sources = c.frame(500);
    const own = sources.find((s) => s.sourceId === A)!;
    expect(own.config?.components.map((x) => x.id)).toEqual([1, 2, 7]);
    expect(own.config?.components[1]).toMatchObject({ pose: { x: 1200 } });
    expect(own.snapshots.flatMap((s) => s.components)).toEqual([belt, robot]);
    expect(own.renderTime).toBe(100);

    const ghost = sources.find((s) => s.sourceId === ghostSourceId(A))!;
    expect(ghost).toMatchObject({ online: false, snapshots: [] });
    expect(ghost.config?.components).toEqual([delta(2)]);
    expect(sources.map((s) => s.sourceId)).toEqual([A, "draft", ghostSourceId(A)]);
  });

  it("puts the conveyors a changed robot's zones lie on into its ghost, without a body, so the PLC's zones show", () => {
    const live = new FakeLive();
    const zone = { conveyorId: 1, start: 750, end: 1250, allocationOffset: 0, ccsOffset: 750, startY: 0, endY: 0 };
    live.plc(A, [conveyor(1), { ...delta(2), zones: [zone] } as ComponentConfig]);
    const c = connected(live);
    c.importSource(A);
    c.set(`${A}#2`, ["zones", "0", "end"], 1400);

    const ghost = c.frame(0).find((s) => s.sourceId === ghostSourceId(A))!;
    expect(ghost.config?.components).toEqual([{ ...delta(2), zones: [zone] }, { ...conveyor(1), body: false }]);
  });

  it("shows no live states over the draft while its PLC is offline", () => {
    const live = new FakeLive();
    const belt = { type: "conveyor" as const, id: 1, timestamp: "0", beltPosition: 0, products: [], fault: null };
    live.plc(A, [conveyor(1)], [belt]);
    const c = connected(live);
    c.importSource(A);
    expect(c.frame(500).find((s) => s.sourceId === A)!.snapshots).toHaveLength(1);

    live.send({ kind: "status", sourceId: A, sourceName: "Line PLC", status: { plcConnected: false, lastError: "gone" } });
    expect(c.frame(500).find((s) => s.sourceId === A)).toMatchObject({ snapshots: [], online: true });
  });

  it("asks before an import replaces changes to the draft's components of that PLC", () => {
    const live = new FakeLive();
    live.plc(A, [conveyor(1)]);
    let allow = false;
    const asked: string[] = [];
    const c = connected(live);
    const confirm = (name: string) => (asked.push(name), allow);
    c.importSource(A, confirm);
    expect(asked).toEqual([]); // nothing of that PLC in the draft yet

    c.set(`${A}#1`, ["length"], 2500);
    c.importSource(A, confirm);
    expect(asked).toEqual(["Line PLC"]);
    expect(c.getSnapshot().draft.components[0]).toMatchObject({ length: 2500 });
    allow = true;
    c.importSource(A, confirm);
    expect(c.getSnapshot().draft.components[0]).toMatchObject({ length: 2000 });
  });

  it("hints where the draft assumed other hardware than the PLC has, and takes the PLC's in one step", () => {
    const live = new FakeLive();
    const plcDelta = { ...delta(2), upperArmLength: 450, lowerArmLength: 1100 };
    live.plc(A, [conveyor(1), plcDelta]);
    const c = connected(live);
    // Placed offline with the palette's assumed geometry, then given the PLC's source and id.
    c.add("delta", { x: 1000, y: 0 });
    c.set("draft#1", ["sourceId"], A);
    c.set(`${A}#1`, ["id"], 2);
    c.set(`${A}#2`, ["name"], "Delta 2");

    expect(c.getSnapshot().issues).toEqual([
      { severity: "warning", hardware: true, key: `${A}#2`, message: "Delta 2: upper arm length is 400 mm in the draft, 450 mm in the PLC" },
      { severity: "warning", hardware: true, key: `${A}#2`, message: "Delta 2: lower arm length is 950 mm in the draft, 1100 mm in the PLC" },
    ]);

    c.adoptPlcHardware(`${A}#2`);
    expect(c.getSnapshot().draft.components[0]).toMatchObject({ upperArmLength: 450, lowerArmLength: 1100 });
    expect(c.getSnapshot().issues).toEqual([]);
    c.undo();
    expect(c.getSnapshot().draft.components[0]).toMatchObject({ upperArmLength: 400, lowerArmLength: 950 });
  });

  it("follows the PLC: a new configuration is reconciled again", () => {
    const live = new FakeLive();
    live.plc(A, [conveyor(1)]);
    const c = connected(live);
    c.importSource(A);
    expect(c.getSnapshot().matches[`${A}#1`]).toBe("matched");

    live.send({ kind: "config", sourceId: A, protocolVersion: PROTOCOL_VERSION, configVersion: 2, errors: [], components: [conveyor(1, A, 500)] });
    expect(c.getSnapshot().matches[`${A}#1`]).toBe("changed");
  });
});
