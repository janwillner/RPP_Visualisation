import { moduleStarts } from "@rpp/protocol";
import type {
  Body,
  CartesianConfig,
  ComponentConfig,
  ComponentType,
  ConveyorConfig,
  DeltaConfig,
  Finger,
  LimitArea,
  Pose,
  SensorConfig,
  StationConfig,
  TrackModule,
  VisionConfig,
  XtsGantryConfig,
  XtsLoopConfig,
} from "@rpp/protocol";

/**
 * What the configurator's palette offers, with the configuration a new component starts from. Its hardware geometry
 * (arm lengths, strokes, bodies and the like) is assumed until a PLC reports its own (ADR 0016).
 */

/** The component types the palette offers: every type of the protocol. */
export const PALETTE_TYPES = ["conveyor", "delta", "xtsGantry", "xtsLoop", "cartesian", "vision", "sensor", "station"] as const satisfies readonly ComponentType[];
export type PaletteType = (typeof PALETTE_TYPES)[number];

/** Display name of a palette entry, also the start of a new component's name. */
export const PALETTE_LABELS: Record<PaletteType, string> = {
  conveyor: "Conveyor",
  delta: "Delta",
  xtsGantry: "XTS gantry",
  xtsLoop: "XTS loop",
  cartesian: "Cartesian",
  vision: "Vision",
  sensor: "Sensor",
  station: "Station",
};

/** Belt surface height of a new conveyor, mm; the other types are placed to work on a belt at this height. */
const BELT_Z = 800;
/** Height of the products the robots are placed for, mm. */
const PRODUCT_Z = 40;
/** Base height of a new Delta, mm: its working area reaches down to a belt at BELT_Z. */
const DELTA_Z = 1900;

/** Length of a standard XTS motor module, mm. */
export const XTS_MODULE_LENGTH = 250;

const origin = () => ({ x: 0, y: 0, z: 0 });
const at = (x: number, y: number, z: number, rx = 0): Pose => ({ x, y, z, rx, ry: 0, rz: 0 });
const box = (pose: Pose, length: number, width: number, height: number, role: Body["role"] = "structure"): Body => ({
  shape: "box",
  role,
  pose,
  length,
  width,
  height,
  topLength: 0,
  topWidth: 0,
});
const modules = (kinds: TrackModule["kind"][]): TrackModule[] => kinds.map((kind) => ({ kind, length: XTS_MODULE_LENGTH }));
const straight = (n: number): TrackModule["kind"][] => Array.from({ length: n }, () => "straight");

/** A new component of `type` at (x, y) on the floor plane; the height is the type's usual one. */
export function defaultComponent(
  type: PaletteType,
  identity: { id: number; sourceId: string; name: string },
  { x, y }: { x: number; y: number },
): ComponentConfig {
  const common = { ...identity, originShift: origin() };
  const robot = { zones: [], fingers: [], limitArea: null, tcpLimitArea: null };
  switch (type) {
    case "conveyor":
      return { type, ...common, pose: at(x, y, BELT_Z), length: 2000, width: 400, productTypes: [], body: true } satisfies ConveyorConfig;
    case "delta":
      return {
        type,
        ...common,
        ...robot,
        pose: at(x, y, DELTA_Z),
        baseRadius: 200,
        effectorRadius: 50,
        upperArmLength: 400,
        lowerArmLength: 950,
        workingArea: { radius: 700, zMin: -1300, zMax: -700, coneHeight: 200, coneBottomRadius: 400 },
      } satisfies DeltaConfig;
    case "xtsGantry":
      // The flange reaches the product tops with the Z axis halfway down.
      return {
        type,
        ...common,
        ...robot,
        pose: at(x, y, BELT_Z + PRODUCT_Z + 500),
        modules: modules(straight(6)),
        xMin: 0,
        xMax: 700,
        zMin: -200,
        zMax: 0,
        toolOffsetX: 150,
        toolOffsetZ: -400,
        moverLength: 155,
        moverWidth: 80,
      } satisfies XtsGantryConfig;
    case "xtsLoop":
      // Two straights of four modules joined at each end by two left curves: the tool points at the product tops.
      return {
        type,
        ...common,
        zones: [],
        fingers: [],
        pose: at(x, y, BELT_Z + PRODUCT_Z + 120),
        modules: modules([...straight(4), "curveLeft", "curveLeft", ...straight(4), "curveLeft", "curveLeft"]),
        toolOffset: 120,
        moverLength: 100,
        moverWidth: 60,
      } satisfies XtsLoopConfig;
    case "cartesian":
      return {
        type,
        ...common,
        ...robot,
        pose: at(x, y, BELT_Z + PRODUCT_Z + 600),
        axes: "xyz",
        xMin: 0,
        xMax: 1200,
        yMin: 0,
        yMax: 1000,
        zMin: -600,
        zMax: 0,
        railHeight: 800,
      } satisfies CartesianConfig;
    case "vision":
      // As _FB_VisuVision.m_Configure describes it: housing, lens and a 400 mm field of view on the belt 800 mm below.
      return {
        type,
        ...common,
        zones: [],
        pose: at(x, y, BELT_Z + 800),
        bodies: [
          box(at(0, 0, 60), 100, 80, 140),
          { ...box(at(0, 0, 0), 50, 50, 60, "sensor"), shape: "cylinder" },
          { ...box(at(0, 0, -800), 400, 400, 800, "fieldOfView"), shape: "frustum", topLength: 50, topWidth: 50 },
        ],
      } satisfies VisionConfig;
    case "sensor":
      // A light barrier at a belt side: its head and the beam across the belt along local +Y.
      return {
        type,
        ...common,
        zones: [],
        pose: at(x, y, BELT_Z + 20),
        bodies: [
          box(at(0, 0, -30), 30, 40, 60, "sensor"),
          { ...box(at(0, 20, 0, -90), 8, 8, 500, "beam"), shape: "cylinder" },
        ],
      } satisfies SensorConfig;
    case "station":
      // A reject unit on the floor at a belt side: its housing and the pusher at the belt edge (local +Y across it).
      return {
        type,
        ...common,
        zones: [],
        pose: at(x, y, 0),
        bodies: [box(at(0, -70, 0), 160, 140, BELT_Z + 120), box(at(0, 15, BELT_Z + 10), 120, 30, 50)],
      } satisfies StationConfig;
  }
}

/** The height a new component of `type` is placed at, MCS Z mm: a drop lands under the pointer at that height. */
export function placementHeight(type: PaletteType): number {
  return defaultComponent(type, { id: 0, sourceId: "", name: "" }, { x: 0, y: 0 }).pose.z;
}

/** A body added to a detector or station: a 100 mm box standing on its origin, to edit from there. */
export const newBody = (): Body => box(at(0, 0, 0), 100, 100, 100);

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
