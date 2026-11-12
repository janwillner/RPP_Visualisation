import { describe, expect, it } from "vitest";
import type { ComponentConfig } from "@rpp/protocol";
import { Configurator, DRAFT_SOURCE } from "../src/configurator";

/** The components the 3D view gets from the configurator, over every source. */
const shown = (c: Configurator): ComponentConfig[] => c.frame().flatMap((s) => s.config?.components ?? []);

describe("Configurator", () => {
  it("places a component from the palette where it is dropped, on the 10 mm grid", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 1234.4, y: -56 });

    const [conveyor] = shown(c);
    expect(conveyor).toMatchObject({ type: "conveyor", id: 1, sourceId: DRAFT_SOURCE, name: "Conveyor 1" });
    expect(conveyor!.pose).toMatchObject({ x: 1230, y: -60, rx: 0, ry: 0, rz: 0 });
    expect(c.frame()).toHaveLength(1);
  });

  it("changes any value of a component, e.g. a conveyor's length or the rotation of its pose", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });
    const key = c.getSnapshot().selection!;

    c.set(key, ["length"], 3500);
    c.set(key, ["pose", "rz"], 90);

    expect(shown(c)[0]).toMatchObject({ length: 3500, pose: { rz: 90 } });
  });

  it("undoes and redoes every edit; a new edit drops what could be redone", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });
    const key = c.getSnapshot().selection!;
    c.set(key, ["length"], 3500);

    c.undo();
    expect(shown(c)[0]).toMatchObject({ length: 2000 });
    c.undo();
    expect(shown(c)).toEqual([]);
    expect(c.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true });

    c.redo();
    c.redo();
    expect(shown(c)[0]).toMatchObject({ length: 3500 });
    expect(c.getSnapshot().canRedo).toBe(false);

    c.undo();
    c.set(key, ["width"], 600);
    expect(c.getSnapshot().canRedo).toBe(false);
    expect(shown(c)[0]).toMatchObject({ length: 2000, width: 600 });
  });

  it("moves a component along the floor on the grid while it is dragged; one undo puts it back", () => {
    const c = new Configurator();
    c.add("delta", { x: 1000, y: 500 });
    const key = c.getSnapshot().selection!;

    c.beginGesture();
    c.moveTo(key, { x: 1104, y: 512 });
    c.moveTo(key, { x: 1496, y: 788 });
    c.endGesture();
    expect(shown(c)[0]!.pose).toMatchObject({ x: 1500, y: 790, z: 1900 });

    c.undo();
    expect(shown(c)[0]!.pose).toMatchObject({ x: 1000, y: 500 });
  });

  it("puts a component caught by a snap point exactly on it, off the grid", () => {
    const c = new Configurator();
    c.add("delta", { x: 0, y: 0 });
    c.moveTo(c.getSnapshot().selection!, { x: 2003.4, y: -201.7 }, { onGrid: false });
    expect(shown(c)[0]!.pose).toMatchObject({ x: 2003.4, y: -201.7 });
  });

  it("leaves no undo step and stays saved for a change that changes nothing", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });
    const key = c.getSnapshot().selection!;
    c.save();

    c.set(key, ["length"], 2000);
    c.moveTo(key, { x: 3, y: -2 });
    expect(c.getSnapshot()).toMatchObject({ saved: true });
    c.undo();
    expect(shown(c)).toEqual([]);
  });

  it("leaves no undo step for a drag that ends where it started", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });
    const key = c.getSnapshot().selection!;
    c.save();

    c.beginGesture();
    c.moveTo(key, { x: 500, y: 0 });
    c.moveTo(key, { x: 0, y: 0 });
    c.endGesture();
    expect(c.getSnapshot()).toMatchObject({ saved: true });
    c.undo();
    expect(shown(c)).toEqual([]);
  });

  it("turns a component by 90° about its vertical axis, within 0° to 360°", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });
    const key = c.getSnapshot().selection!;

    c.rotate(key, -90);
    expect(shown(c)[0]!.pose.rz).toBe(270);
    c.rotate(key, 90);
    c.rotate(key, 90);
    expect(shown(c)[0]!.pose.rz).toBe(90);
  });

  it("removes a component and drops its selection", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });
    c.add("delta", { x: 0, y: 0 });
    const delta = c.getSnapshot().selection!;

    c.remove(delta);
    expect(shown(c).map((x) => x.type)).toEqual(["conveyor"]);
    expect(c.getSnapshot().selection).toBeUndefined();
  });

  it("keeps a component selected when its manifest id or source changes, and draws it in its new source", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });

    c.set(c.getSnapshot().selection!, ["id"], 7);
    c.set(c.getSnapshot().selection!, ["sourceId"], "ads:5.1.2.3.1.1:851");

    expect(c.getSnapshot().selection).toBe("ads:5.1.2.3.1.1:851#7");
    expect(c.frame().map((s) => s.sourceId)).toEqual(["ads:5.1.2.3.1.1:851"]);
    expect(shown(c)[0]).toMatchObject({ id: 7, sourceId: "ads:5.1.2.3.1.1:851" });
  });

  it("flags a manifest id used twice in one source, or one that is no positive whole number, as an error", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });
    c.add("delta", { x: 0, y: 0 });
    expect(c.getSnapshot().issues).toEqual([]);

    c.set("draft#2", ["id"], 1);
    expect(c.getSnapshot().issues).toEqual([
      { severity: "error", key: "draft#1", message: "Conveyor 1: id 1 is used twice in source draft" },
      { severity: "error", key: "draft#1", message: "Delta 2: id 1 is used twice in source draft" },
    ]);

    c.set("draft#1", ["sourceId"], "ads:5.1.2.3.1.1:851");
    expect(c.getSnapshot().issues).toEqual([]);

    c.set("ads:5.1.2.3.1.1:851#1", ["id"], 0);
    expect(c.getSnapshot().issues).toEqual([
      { severity: "error", key: "ads:5.1.2.3.1.1:851#0", message: "Conveyor 1: id must be a whole number from 1" },
    ]);
  });

  it("flags a zone on a conveyor its source does not have as an error, e.g. after the conveyor's id changed", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });
    c.add("delta", { x: 0, y: 0 });
    const zone = { conveyorId: 1, start: 100, end: 600, allocationOffset: 0, ccsOffset: 100, startY: 0, endY: 0 };
    c.set("draft#2", ["zones"], [zone]);
    expect(c.getSnapshot().issues).toEqual([]);

    c.set("draft#1", ["id"], 5);
    expect(c.getSnapshot().issues).toEqual([
      { severity: "error", key: "draft#2", message: "Delta 2: zone 1 lies on conveyor 1, which source draft does not have" },
    ]);
  });

  describe("zones", () => {
    /** A conveyor (draft#1, 2000 mm) and a Delta (draft#2) over it. */
    const line = () => {
      const c = new Configurator();
      c.add("conveyor", { x: 0, y: 0 });
      c.add("delta", { x: 1000, y: 0 });
      return c;
    };
    const zonesOf = (c: Configurator, key: string) =>
      (c.getSnapshot().draft.components.find((x) => `${x.sourceId}#${x.id}` === key) as { zones: unknown[] }).zones;

    it("adds a zone over the middle 500 mm of a conveyor across the whole belt, with its CCS at the start", () => {
      const c = line();
      c.addZone("draft#2", "draft#1");
      expect(zonesOf(c, "draft#2")).toEqual([
        { conveyorId: 1, start: 750, end: 1250, allocationOffset: 0, ccsOffset: 750, startY: 0, endY: 0 },
      ]);
      expect(c.getSnapshot().selection).toBe("draft#2");

      c.undo();
      expect(zonesOf(c, "draft#2")).toEqual([]);
    });

    it("refuses a zone on a conveyor of another source", () => {
      const c = line();
      c.set("draft#1", ["sourceId"], "ads:5.1.2.3.1.1:851");
      c.addZone("draft#2", "ads:5.1.2.3.1.1:851#1");
      expect(zonesOf(c, "draft#2")).toEqual([]);
      expect(c.getSnapshot().notice).toMatch(/same PLC/);
    });

    it("removes a zone, and changes one of its values by its path", () => {
      const c = line();
      c.addZone("draft#2", "draft#1");
      c.addZone("draft#2", "draft#1");
      c.set("draft#2", ["zones", "1", "end"], 1400);
      expect(zonesOf(c, "draft#2")[1]).toMatchObject({ start: 750, end: 1400 });

      c.removeListEntry("draft#2", "zones", 0);
      expect(zonesOf(c, "draft#2")).toEqual([expect.objectContaining({ end: 1400 })]);
    });

    it("drags a zone's ends, CCS and sides to points in belt coordinates, on a turned belt with a shifted origin", () => {
      const c = line();
      // The belt runs along MCS +Y from (1000, 500); its belt coordinates count from 100 mm after the belt start.
      c.set("draft#1", ["pose"], { x: 1000, y: 500, z: 800, rx: 0, ry: 0, rz: 90 });
      c.set("draft#1", ["originShift"], { x: 100, y: 0, z: 0 });
      c.addZone("draft#2", "draft#1");
      expect(zonesOf(c, "draft#2")[0]).toMatchObject({ start: 650, end: 1150 });

      c.dragZone("draft#2", 0, "start", { x: 1000, y: 500 + 100 + 302 });
      c.dragZone("draft#2", 0, "end", { x: 1010, y: 500 + 100 + 1496 });
      c.dragZone("draft#2", 0, "ccs", { x: 990, y: 500 + 100 + 400 });
      expect(zonesOf(c, "draft#2")[0]).toMatchObject({ start: 300, end: 1500, ccsOffset: 400 });

      // The belt's local +Y (its left side) points along MCS −X; the other side starts at the belt edge (±200 mm).
      c.dragZone("draft#2", 0, "left", { x: 1000 - 148, y: 1500 });
      expect(zonesOf(c, "draft#2")[0]).toMatchObject({ startY: 150, endY: -200 });
      c.dragZone("draft#2", 0, "right", { x: 1000 + 51, y: 1500 });
      expect(zonesOf(c, "draft#2")[0]).toMatchObject({ startY: 150, endY: -50 });
    });

    it("keeps a dragged side at least 10 mm from the other one, so the lane never collapses or flips", () => {
      const c = line();
      c.addZone("draft#2", "draft#1");
      c.dragZone("draft#2", 0, "left", { x: 1000, y: 150 });
      c.dragZone("draft#2", 0, "right", { x: 1000, y: -50 });

      c.dragZone("draft#2", 0, "left", { x: 1000, y: -50 });
      expect(zonesOf(c, "draft#2")[0]).toMatchObject({ startY: -40, endY: -50 });
      c.dragZone("draft#2", 0, "left", { x: 1000, y: -120 });
      expect(zonesOf(c, "draft#2")[0]).toMatchObject({ startY: -40, endY: -50 });
      c.dragZone("draft#2", 0, "right", { x: 1000, y: 300 });
      expect(zonesOf(c, "draft#2")[0]).toMatchObject({ startY: -40, endY: -50 });
    });

    it("keeps a new zone on a belt whose length is off the grid", () => {
      const c = line();
      c.set("draft#1", ["length"], 335);
      c.addZone("draft#2", "draft#1");
      expect(zonesOf(c, "draft#2")[0]).toMatchObject({ start: 0, end: 335 });
      expect(c.getSnapshot().issues).toEqual([]);
    });
  });

  describe("product types", () => {
    it("adds product types to a conveyor with the next free number, a 120 × 80 × 40 mm box to start from", () => {
      const c = new Configurator();
      c.add("conveyor", { x: 0, y: 0 });
      c.addProductType("draft#1");
      c.addProductType("draft#1");
      c.set("draft#1", ["productTypes", "1", "shape"], "cylinder");

      expect(shown(c)[0]).toMatchObject({
        productTypes: [
          { id: 1, length: 120, width: 80, height: 40, shape: "box", cornerRadius: 0 },
          { id: 2, length: 120, width: 80, height: 40, shape: "cylinder", cornerRadius: 0 },
        ],
      });
    });

    it("shows one product of each type on its belt, 100 mm apart from the belt start on", () => {
      const c = new Configurator();
      c.add("conveyor", { x: 0, y: 0 });
      c.add("delta", { x: 0, y: 0 });
      c.addProductType("draft#1");
      c.addProductType("draft#1");
      c.set("draft#1", ["productTypes", "0", "length"], 200);

      const [source] = c.frame();
      const states = source!.snapshots.flatMap((s) => s.components);
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({
        type: "conveyor",
        id: 1,
        products: [
          { productType: 1, state: "detected", latchPose: { x: 200, y: 0, z: 0, rz: 0 } },
          { productType: 2, state: "detected", latchPose: { x: 460, y: 0, z: 0, rz: 0 } },
        ],
      });
    });

    it("shows only the preview products that fit on the belt, lying on its surface also with a raised origin", () => {
      const c = new Configurator();
      c.add("conveyor", { x: 0, y: 0 });
      c.set("draft#1", ["originShift"], { x: 0, y: 0, z: 30 });
      for (let i = 0; i < 4; i++) c.addProductType("draft#1");
      for (let i = 0; i < 4; i++) c.set("draft#1", ["productTypes", String(i), "length"], 500);

      const products = c.frame()[0]!.snapshots.flatMap((s) => s.components).flatMap((s) => ("products" in s ? s.products : []));
      // 100 + 500 + 100 + 500 + 100 + 500 = 1800 fits on 2000 mm; a fourth would end at 2400.
      expect(products.map((p) => p.latchPose)).toEqual([
        { x: 350, y: 0, z: -30, rz: 0 },
        { x: 950, y: 0, z: -30, rz: 0 },
        { x: 1550, y: 0, z: -30, rz: 0 },
      ]);
    });

    it("flags a product type number used twice on a conveyor as an error", () => {
      const c = new Configurator();
      c.add("conveyor", { x: 0, y: 0 });
      c.addProductType("draft#1");
      c.addProductType("draft#1");
      c.set("draft#1", ["productTypes", "1", "id"], 1);
      expect(c.getSnapshot().issues).toEqual([
        { severity: "error", key: "draft#1", message: "Conveyor 1: product type 1 is defined twice" },
      ]);
    });
  });

  it("warns of a zone or CCS past the belt start or end, as the visualisation does", () => {
    const c = new Configurator();
    c.add("conveyor", { x: 0, y: 0 });
    c.add("delta", { x: 0, y: 0 });
    c.addZone("draft#2", "draft#1");
    c.set("draft#2", ["zones", "0", "end"], 2100);
    c.set("draft#2", ["zones", "0", "ccsOffset"], -10);
    expect(c.getSnapshot().issues).toEqual([
      { severity: "warning", key: "draft#2", message: "Delta 2: zone on Conveyor 1 (750 to 2100 mm) reaches past the belt (0 to 2000 mm)" },
      { severity: "warning", key: "draft#2", message: "Delta 2: CCS of the zone on Conveyor 1 (-10 mm) lies outside the belt (0 to 2000 mm)" },
    ]);
  });

  describe("draft files", () => {
    it("saves the draft as a file named after the machine and opens it again", () => {
      const c = new Configurator();
      c.add("conveyor", { x: 0, y: 0 });
      c.set(c.getSnapshot().selection!, ["length"], 4200);
      c.rename("Line 4");
      expect(c.getSnapshot().saved).toBe(false);

      const file = c.save();
      expect(file.name).toBe("Line 4.rpp-draft.json");
      expect(c.getSnapshot().saved).toBe(true);

      const other = new Configurator();
      other.open(file.text);
      expect(other.getSnapshot()).toMatchObject({ saved: true, canUndo: false, notice: undefined });
      expect(other.getSnapshot().draft.name).toBe("Line 4");
      expect(shown(other)[0]).toMatchObject({ type: "conveyor", length: 4200 });
    });

    it("refuses a file that is no draft and keeps what is shown", () => {
      const c = new Configurator();
      c.add("conveyor", { x: 0, y: 0 });

      c.open('{"format":"rpp-recording"}');
      expect(c.getSnapshot().notice).toMatch(/not a draft/i);
      c.open("{ broken");
      expect(c.getSnapshot().notice).toMatch(/not a draft/i);
      expect(shown(c)).toHaveLength(1);

      // A newer file layout or protocol than this configurator knows.
      const draft = JSON.parse(new Configurator().save().text);
      c.open(JSON.stringify({ ...draft, formatVersion: draft.formatVersion + 1 }));
      expect(c.getSnapshot().notice).toMatch(/newer/i);
      c.open(JSON.stringify({ ...draft, protocolVersion: draft.protocolVersion + 1 }));
      expect(c.getSnapshot().notice).toMatch(/newer/i);
      expect(shown(c)).toHaveLength(1);

      c.dismissNotice();
      expect(c.getSnapshot().notice).toBeUndefined();
    });

    it("discards unsaved changes for a new or opened draft only when allowed to", () => {
      let allow = false;
      const c = new Configurator(() => allow);
      c.add("conveyor", { x: 0, y: 0 });
      const file = new Configurator().save();

      c.newDraft();
      c.open(file.text);
      expect(shown(c)).toHaveLength(1);

      allow = true;
      c.newDraft();
      expect(shown(c)).toEqual([]);
      expect(c.getSnapshot()).toMatchObject({ saved: true, canUndo: false });
    });
  });
});
