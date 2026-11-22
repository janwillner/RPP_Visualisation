import { moduleStarts } from "@rpp/protocol";
import type { Body, ComponentConfig, Finger, LimitArea } from "@rpp/protocol";

/**
 * What the configurator adds to a component the PLC provides: a body, a finger, an optional area. Components
 * themselves come only from the PLCs (ADR 0024).
 */

/** Length of a standard XTS motor module, mm. */
export const XTS_MODULE_LENGTH = 250;

/** A body added to a detector or station: a 100 mm box standing on its origin, to edit from there. */
export const newBody = (): Body => ({
  shape: "box",
  role: "structure",
  pose: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
  length: 100,
  width: 100,
  height: 100,
  topLength: 0,
  topWidth: 0,
});

/** A finger added to a robot's gripper: a 40 mm suction cup, 50 mm long, `x` mm along the flange's X (ADR 0018). */
export const newFinger = (x: number): Finger => ({ diameter: 40, height: 50, offset: { x, y: 0, z: 0, rz: 0 } });

/** The optional areas a robot may have. */
export const AREA_FIELDS = ["limitArea", "tcpLimitArea"] as const;
export type AreaField = (typeof AREA_FIELDS)[number];
export const isAreaField = (field: string): field is AreaField => (AREA_FIELDS as readonly string[]).includes(field);

/** A robot that may have a limit area and a TCP limit area. */
export type LimitedRobot = Extract<ComponentConfig, { limitArea: unknown }>;

/**
 * The box a new optional area starts as: a limit area as the robot's reach (a Delta's working area, a Cartesian
 * robot's strokes, flat where it lacks an axis; the reach of an XTS gantry's flanges along its track), a TCP limit area
 * as a box around the flange.
 */
export function defaultArea(c: LimitedRobot, field: AreaField): LimitArea {
  if (field === "tcpLimitArea") return { xMin: -60, xMax: 60, yMin: -60, yMax: 60, zMin: -100, zMax: 20 };
  switch (c.type) {
    case "delta": {
      const { radius: r, zMin, zMax } = c.workingArea;
      return { xMin: -r, xMax: r, yMin: -r, yMax: r, zMin, zMax };
    }
    case "cartesian": {
      // Without a Y axis Y is always 0; without a Z axis the flange stays at zMin.
      const [yMin, yMax] = c.axes === "xz" ? [0, 0] : [c.yMin, c.yMax];
      const [zMin, zMax] = c.axes === "xy" ? [c.zMin, c.zMin] : [c.zMin, c.zMax];
      return { xMin: c.xMin, xMax: c.xMax, yMin, yMax, zMin, zMax };
    }
    case "xtsGantry": {
      // The track runs along local +Y (u of its plane) and a curve turns it towards local −X (v, to its left).
      const ends = moduleStarts(c.modules);
      const along = ends.map((p) => p.u);
      const across = ends.map((p) => -p.v);
      const { toolOffsetX: x, toolOffsetZ: z } = c;
      return {
        xMin: c.xMin + x + Math.min(...across),
        xMax: c.xMax + x + Math.max(...across),
        yMin: Math.min(...along),
        yMax: Math.max(...along),
        zMin: c.zMin + z,
        zMax: c.zMax + z,
      };
    }
  }
}
