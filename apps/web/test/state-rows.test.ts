import { describe, expect, it } from "vitest";
import type { ComponentState } from "@rpp/protocol";
import { stateRows } from "../src/state-rows";

const pose = { x: 1, y: 2, z: 3, rx: 0, ry: 90, rz: -45 };

describe("stateRows", () => {
  it("lists a component's values with their unit, leaving out what the inspector shows elsewhere", () => {
    const state: ComponentState = {
      type: "cartesian",
      id: 5,
      timestamp: "1000",
      x: 100,
      y: 250.25,
      z: -30,
      gripperActive: true,
      fingers: [],
      fault: { message: "Axis error" },
    };
    expect(stateRows(state).values).toEqual([
      { label: "X", value: "100.0 mm" },
      { label: "Y", value: "250.3 mm" },
      { label: "Z", value: "-30.0 mm" },
      { label: "Gripper active", value: "on" },
    ]);
  });

  it("shows a position as one value", () => {
    const state: ComponentState = {
      type: "delta",
      id: 2,
      timestamp: "1",
      actualTcp: { x: 10, y: -20, z: -800 },
      setpointTcp: { x: 11, y: -20, z: -800 },
      fingers: [],
      fault: null,
    };
    expect(stateRows(state).values).toEqual([
      { label: "Actual tcp", value: "X 10.0 · Y -20.0 · Z -800.0 mm" },
      { label: "Setpoint tcp", value: "X 11.0 · Y -20.0 · Z -800.0 mm" },
    ]);
  });

  it("shows lists as tables, with the lists of their entries (such as a mover's fingers) as tables of their own", () => {
    const state: ComponentState = {
      type: "xtsGantry",
      id: 3,
      timestamp: "1",
      z: 50,
      movers: [
        { id: 7, position: 400, x: 12, gripperActive: false, fingers: [{ pose, active: true }], fault: null },
        { id: 8, position: 900, x: 0, gripperActive: true, fingers: [{ pose, active: false }], fault: { message: "" } },
      ],
      modules: [],
      fault: null,
    };
    const rows = stateRows(state);
    expect(rows.values).toEqual([{ label: "Z", value: "50.0 mm" }]);
    expect(rows.tables).toEqual([
      {
        title: "Movers",
        head: ["Id", "Position [mm]", "X [mm]", "Gripper active", "Fault"],
        rows: [
          ["7", "400.0", "12.0", "off", ""],
          ["8", "900.0", "0.0", "on", "Fault"],
        ],
      },
      {
        title: "Fingers",
        head: ["Finger", "X [mm]", "Y [mm]", "Z [mm]", "Rx [°]", "Ry [°]", "Rz [°]", "Active"],
        rows: [
          ["7.1", "1.0", "2.0", "3.0", "0.0", "90.0", "-45.0", "on"],
          ["8.1", "1.0", "2.0", "3.0", "0.0", "90.0", "-45.0", "off"],
        ],
      },
    ]);
  });

  it("numbers the fingers of a robot without movers from 1", () => {
    const state: ComponentState = {
      type: "delta",
      id: 2,
      timestamp: "1",
      actualTcp: { x: 0, y: 0, z: 0 },
      setpointTcp: { x: 0, y: 0, z: 0 },
      fingers: [
        { pose, active: true },
        { pose, active: false },
      ],
      fault: null,
    };
    expect(stateRows(state).tables.map((t) => [t.title, t.rows.map((r) => r[0])])).toEqual([["Fingers", ["1", "2"]]]);
  });
});
