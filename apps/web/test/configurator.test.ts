import { describe, expect, it } from "vitest";
import type { ComponentConfig } from "@rpp/protocol";
import { Configurator, DRAFT_SOURCE } from "../src/configurator/configurator";

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
