import { describe, expect, it } from "vitest";
import {
  COMPONENT_SCHEMAS,
  PARAMETER_FIELDS,
  type ComponentConfig,
  type ParametersMessage,
  type TypedParameters,
  type XtsGantryConfig,
} from "@rpp/protocol";
import { Configurator } from "../src/configurator";
import { PALETTE_TYPES } from "../src/component-defaults";
import { properties } from "../src/property-fields";
import { A, connected, FakeLive } from "./fake-live";

/** The components the 3D view gets from the configurator, over every source. */
const shown = (c: Configurator): ComponentConfig[] => c.frame().flatMap((s) => s.config?.components ?? []);

/** A configurator with one component of `type` placed and selected. */
function placed(type: (typeof PALETTE_TYPES)[number]) {
  const c = new Configurator();
  c.add(type, { x: 1000, y: 500 });
  const key = c.getSnapshot().selection!;
  const component = () => c.getSnapshot().draft.components.find((x) => `${x.sourceId}#${x.id}` === key)!;
  return { c, key, component };
}

describe("Configurator: every component type (#24)", () => {
  it("offers every component type of the protocol in its palette, each placed as a valid configuration", () => {
    expect([...PALETTE_TYPES].sort()).toEqual(Object.keys(COMPONENT_SCHEMAS).sort());
    for (const type of PALETTE_TYPES) {
      const { c, component } = placed(type);
      expect(COMPONENT_SCHEMAS[type].config.safeParse(component()).success, type).toBe(true);
      expect(shown(c)[0]).toMatchObject({ type, pose: { x: 1000, y: 500 } });
      expect(c.getSnapshot().issues, type).toEqual([]);
    }
  });

  it("writes the parameter set of every type to a PLC that has the same components", () => {
    const live = new FakeLive();
    const components = PALETTE_TYPES.map((type, i) => {
      const { component } = placed(type);
      return { ...component(), sourceId: A, id: i + 1 } as ComponentConfig;
    });
    live.plc(A, components);
    const set = (c: ComponentConfig): TypedParameters => {
      const fields = PARAMETER_FIELDS[c.type];
      return { type: c.type, parameters: Object.fromEntries(fields.map((f) => [f, (c as Record<string, unknown>)[f]])) } as TypedParameters;
    };
    const message: ParametersMessage = {
      kind: "parameters",
      sourceId: A,
      writable: true,
      components: components.map((c) => ({ id: c.id, activeVersion: 0, handledStageId: 0, result: "none", message: "", set: set(c) })),
    };
    live.send(message);
    const c = connected(live);
    c.importSource(A);
    for (const comp of components) c.set(`${A}#${comp.id}`, ["pose", "x"], comp.pose.x + 100);

    const plan = c.writePlan(A);
    expect(plan.blocked).toBeUndefined();
    expect(plan.changes.map((ch) => ch.fields)).toEqual(components.map((comp) => [{ path: "pose.x", from: String(comp.pose.x), to: String(comp.pose.x + 100) }]));
  });

  describe("track modules", () => {
    it("adds straight and curve modules of 250 mm to an XTS track, edits and removes them", () => {
      const { c, key, component } = placed("xtsGantry");
      const before = (component() as XtsGantryConfig).modules.length;

      c.addModule(key, "straight");
      c.addModule(key, "curveRight");
      expect((component() as XtsGantryConfig).modules.slice(before)).toEqual([
        { kind: "straight", length: 250 },
        { kind: "curveRight", length: 250 },
      ]);

      c.set(key, ["modules", String(before), "length"], 125);
      c.removeListEntry(key, "modules", before + 1);
      expect((component() as XtsGantryConfig).modules.slice(before)).toEqual([{ kind: "straight", length: 125 }]);
    });

    it("lists every module in the property panel, its kind a choice", () => {
      const { component } = placed("xtsLoop");
      const { lists, groups } = properties(component());
      expect(lists.map((l) => l.name)).toContain("modules");
      const first = groups.find((g) => g.entry?.list === "modules" && g.entry.index === 0)!;
      expect(first.title).toBe("Module 1");
      expect(first.fields).toEqual([
        expect.objectContaining({ kind: "choice", key: "kind", options: ["straight", "curveLeft", "curveRight"], value: "straight" }),
        expect.objectContaining({ kind: "number", key: "length", value: 250 }),
      ]);
    });

    it("warns of an XTS loop whose track does not end where it starts, and of a module without a length", () => {
      const { c, key } = placed("xtsLoop");
      expect(c.getSnapshot().issues).toEqual([]);

      c.addModule(key, "straight");
      expect(c.getSnapshot().issues).toEqual([
        { severity: "warning", key, message: "XTS loop 1: the track does not end where it starts" },
      ]);
      c.undo();
      c.set(key, ["modules", "0", "length"], 0);
      expect(c.getSnapshot().issues).toContainEqual({ severity: "error", key, message: "XTS loop 1: track module 1 has no length" });
      c.set(key, ["modules"], []);
      expect(c.getSnapshot().issues).toContainEqual({ severity: "error", key, message: "XTS loop 1: the track has no modules" });
    });
  });

  describe("bodies", () => {
    it("adds a box body to a detector or station, edits its pose and size and removes it", () => {
      const { c, key, component } = placed("station");
      const before = (component() as { bodies: unknown[] }).bodies.length;

      c.addBody(key);
      c.set(key, ["bodies", String(before), "pose", "z"], 300);
      c.set(key, ["bodies", String(before), "shape"], "cylinder");
      expect((component() as { bodies: unknown[] }).bodies[before]).toEqual({
        shape: "cylinder",
        role: "structure",
        pose: { x: 0, y: 0, z: 300, rx: 0, ry: 0, rz: 0 },
        length: 100,
        width: 100,
        height: 100,
        topLength: 0,
        topWidth: 0,
      });
      const group = properties(component()).groups.find((g) => g.entry?.list === "bodies" && g.entry.index === before)!;
      expect(group.fields.map((f) => f.label)).toContain("Pose Z");

      c.removeListEntry(key, "bodies", before);
      expect((component() as { bodies: unknown[] }).bodies).toHaveLength(before);
    });
  });

  describe("optional areas", () => {
    it("adds a limit area and a TCP limit area to a robot that has none, edits and removes them", () => {
      const { c, key, component } = placed("cartesian");
      expect(properties(component()).optionals).toEqual([
        expect.objectContaining({ name: "limitArea", title: "Limit area", present: false }),
        expect.objectContaining({ name: "tcpLimitArea", title: "TCP limit area", present: false }),
      ]);

      c.addArea(key, "limitArea");
      c.addArea(key, "tcpLimitArea");
      // The limit area starts as the robot's strokes, the TCP limit area as a box around the flange.
      expect(component()).toMatchObject({
        limitArea: { xMin: 0, xMax: 1200, yMin: 0, yMax: 1000, zMin: -600, zMax: 0 },
        tcpLimitArea: { xMin: -60, xMax: 60, yMin: -60, yMax: 60, zMin: -100, zMax: 20 },
      });
      const props = properties(component());
      expect(props.optionals.every((o) => o.present)).toBe(true);
      const area = props.groups.find((g) => g.optional === "limitArea")!;
      expect(area.fields.map((f) => f.path.join("."))).toEqual([
        "limitArea.xMin",
        "limitArea.xMax",
        "limitArea.yMin",
        "limitArea.yMax",
        "limitArea.zMin",
        "limitArea.zMax",
      ]);

      c.set(key, ["limitArea", "zMax"], -100);
      c.removeArea(key, "tcpLimitArea");
      expect(component()).toMatchObject({ limitArea: { zMax: -100 }, tcpLimitArea: null });
    });

    it("starts a Delta's limit area around its working area", () => {
      const { c, key, component } = placed("delta");
      c.addArea(key, "limitArea");
      expect(component()).toMatchObject({ limitArea: { xMin: -700, xMax: 700, yMin: -700, yMax: 700, zMin: -1300, zMax: -700 } });
    });

    it("starts a Cartesian robot's limit area flat where it lacks an axis", () => {
      const { c, key, component } = placed("cartesian");
      c.set(key, ["axes"], "xz");
      c.addArea(key, "limitArea");
      expect(component()).toMatchObject({ limitArea: { yMin: 0, yMax: 0, zMin: -600, zMax: 0 } });
      expect(c.getSnapshot().issues).toEqual([]);

      c.removeArea(key, "limitArea");
      c.set(key, ["axes"], "xy");
      c.addArea(key, "limitArea");
      expect(component()).toMatchObject({ limitArea: { yMin: 0, yMax: 1000, zMin: -600, zMax: -600 } });
      expect(shown(c)[0]).toMatchObject({ axes: "xy" });
    });

    it("starts an XTS gantry's limit area along its track as far as the flanges reach, also with a curve", () => {
      const { c, key, component } = placed("xtsGantry");
      c.addArea(key, "limitArea");
      // Six straight modules along local +Y; X axes 0..700 with the flange 150 ahead, Z −200..0 with it 400 below.
      expect(component()).toMatchObject({ limitArea: { xMin: 150, xMax: 850, yMin: 0, yMax: 1500, zMin: -600, zMax: -400 } });

      c.removeArea(key, "limitArea");
      c.addModule(key, "curveLeft");
      c.addArea(key, "limitArea");
      // A left curve (a quarter circle of 250 mm, radius ≈ 159 mm) ends ahead and to the left, towards local −X.
      const area = (component() as XtsGantryConfig).limitArea!;
      expect(area.yMax).toBeCloseTo(1500 + 159.15, 1);
      expect(area.xMin).toBeCloseTo(150 - 159.15, 1);
    });

    it("has no optional areas for components without them", () => {
      expect(properties(placed("xtsLoop").component()).optionals).toEqual([]);
      expect(properties(placed("vision").component()).optionals).toEqual([]);
    });
  });
});
