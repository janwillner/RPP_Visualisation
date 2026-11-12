import { describe, expect, it } from "vitest";
import type { ComponentConfig, Finger } from "@rpp/protocol";
import { Configurator } from "../src/configurator/configurator";
import type { PaletteType } from "../src/configurator/component-defaults";
import { properties } from "../src/configurator/property-fields";
import { buildMachineScene } from "../src/scene/scene-model";

/** A configurator with one component of `type` placed and selected. */
function placed(type: PaletteType) {
  const c = new Configurator();
  c.add(type, { x: 1000, y: 500 });
  const key = c.getSnapshot().selection!;
  const component = () => c.getSnapshot().draft.components.find((x) => `${x.sourceId}#${x.id}` === key)!;
  const fingers = () => (component() as Extract<ComponentConfig, { fingers: Finger[] }>).fingers;
  return { c, key, component, fingers };
}

describe("Configurator: gripper layout (#25, ADR 0018)", () => {
  it("adds fingers to a robot's gripper: a 40 × 50 mm cup, each next one 60 mm further along the flange's X", () => {
    const { c, key, fingers } = placed("delta");
    c.addFinger(key);
    c.addFinger(key);
    expect(fingers()).toEqual([
      { diameter: 40, height: 50, offset: { x: 0, y: 0, z: 0, rz: 0 } },
      { diameter: 40, height: 50, offset: { x: 60, y: 0, z: 0, rz: 0 } },
    ]);
  });

  it("drags a finger over the flange's top view on a 5 mm grid, one undo step per drag", () => {
    const { c, key, fingers } = placed("cartesian");
    c.addFinger(key);
    c.beginGesture();
    c.moveFinger(key, 0, { x: 12, y: -3 });
    c.moveFinger(key, 0, { x: 33.4, y: -27.6 });
    c.endGesture();
    expect(fingers()[0]!.offset).toEqual({ x: 35, y: -30, z: 0, rz: 0 });

    c.undo();
    expect(fingers()[0]!.offset).toEqual({ x: 0, y: 0, z: 0, rz: 0 });
  });

  it("edits a finger's values and offset in the property panel and removes it", () => {
    const { c, key, component, fingers } = placed("xtsGantry");
    c.addFinger(key);
    const group = properties(component()).groups.find((g) => g.entry?.list === "fingers" && g.entry.index === 0)!;
    expect(group.title).toBe("Finger 1");
    expect(group.fields.map((f) => f.label)).toEqual(["Diameter", "Height", "Offset X", "Offset Y", "Offset Z", "Offset Rz"]);

    c.set(key, ["fingers", "0", "offset", "rz"], 45);
    expect(fingers()[0]!.offset.rz).toBe(45);
    c.removeListEntry(key, "fingers", 0);
    expect(fingers()).toEqual([]);
  });

  it("flags a finger without a diameter or height as an error", () => {
    const { c, key } = placed("delta");
    c.addFinger(key);
    c.set(key, ["fingers", "0", "height"], 0);
    expect(c.getSnapshot().issues).toContainEqual({ severity: "error", key, message: "Delta 1: finger 1 has no diameter or height" });
  });

  it("draws a robot's fingers in the 3D view at their offsets on the flange of its rest pose", () => {
    const { c, key } = placed("delta");
    c.addFinger(key);
    c.moveFinger(key, 0, { x: 70, y: 0 });

    const scene = buildMachineScene(c.frame(), new Set());
    const [finger] = scene.sources[0]!.scene.fingers;
    // The Delta at (1000, 500, 1900) rests with its TCP in the middle of its working area, 1000 mm below its base.
    expect(finger!.transform.position[0]).toBeCloseTo(1.07, 5);
    expect(finger!.transform.position[1]).toBeCloseTo(0.9, 5);
    expect(finger!.transform.position[2]).toBeCloseTo(-0.5, 5);
  });

  it("gives every robot type a rest pose for its fingers, and only robots with fingers one", () => {
    for (const type of ["delta", "xtsGantry", "xtsLoop", "cartesian"] as const) {
      const { c, key } = placed(type);
      expect(buildMachineScene(c.frame(), new Set()).sources[0]!.scene.fingers, type).toEqual([]);
      c.addFinger(key);
      expect(buildMachineScene(c.frame(), new Set()).sources[0]!.scene.fingers, type).toHaveLength(1);
      expect(c.getSnapshot().issues, type).toEqual([]);
    }
  });
});

describe("Configurator: drafts saved before finger offsets (protocol 19)", () => {
  it("opens them with every finger on the flange centre", () => {
    const { c, key } = placed("delta");
    c.addFinger(key);
    const saved = JSON.parse(c.save().text);
    // As protocol 19 saved it: fingers without an offset.
    saved.protocolVersion = 19;
    for (const component of saved.components) for (const f of component.fingers) delete f.offset;

    const opened = new Configurator();
    opened.open(JSON.stringify(saved));
    expect(opened.getSnapshot().notice).toBeUndefined();
    expect(opened.getSnapshot().draft.components[0]).toMatchObject({
      fingers: [{ diameter: 40, height: 50, offset: { x: 0, y: 0, z: 0, rz: 0 } }],
    });
  });
});
