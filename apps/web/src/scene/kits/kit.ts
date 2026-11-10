import type {
  ComponentConfig,
  ComponentState,
  ConveyorConfig,
  Finger,
  FingerState,
  LimitArea,
  Pose,
  Position,
  TrackModule,
  Zone,
} from "@rpp/protocol";
import { child, type Frame, frameFromPose, toLocal, toMcs, toRenderer, type Vec3 } from "../frames";
import type { SceneModel, SnapLayer, SnapPoint } from "../scene-model";

/**
 * What every component kit is built from: the kit's shape, the build context through which it adds its parts to the
 * scene, and the helpers kits share (units, label heights, snap points, interpolation).
 */

export type ComponentType = ComponentConfig["type"];

export type ConfigOf<T extends ComponentType> = Extract<ComponentConfig, { type: T }>;

export type StateOf<T extends ComponentType> = Extract<ComponentState, { type: T }>;

/** What a component's kit adds its part of the scene through. */
export interface BuildContext {
  /** The scene so far, hidden components included; they are dropped at the end. */
  scene: SceneModel;
  /**
   * Where a picked product hangs, by `carrierKey`: an MCS frame whose origin touches the product's top, whose rotation
   * orients the product and whose local −Z points to the product.
   */
  carriers: Map<string, Frame>;
  /**
   * A label at an MCS anchor for a component (`part` null) or one of its parts (e.g. "Mover 2"), and its line in the
   * component list.
   */
  addFault(componentId: number, part: string | null, message: string | null, anchor: Vec3): void;
  /** Fingers of one robot's grippers (one per mover), their grip points as carriers and snap points. */
  addGripper(
    robot: { id: number; name: string; pose: Pose; fingers: Finger[]; originShift: Position },
    grippers: GripperSource[],
  ): void;
  /** A component's zones on the conveyors, with their allocation areas, CCS lines, snap points and warnings. */
  addZones(c: { id: number; name: string; zones: Zone[] }): void;
  /** A robot's limit area (Delta, XTS gantry, Cartesian), a box in its frame with its corners as snap points. */
  addLimitArea(c: { id: number; name: string; pose: Pose; originShift: Position; limitArea: LimitArea | null }): void;
  warn(message: string): void;
  /** Whether the snap points only measure mode needs are built: on products, which are many, and on TCP limit areas. */
  measureSnapPoints: boolean;
}

/** How one component type becomes part of the scene. */
export interface ComponentKit<T extends ComponentType> {
  build(c: ConfigOf<T>, state: StateOf<T> | undefined, ctx: BuildContext): void;
  /** The state between two snapshots (`f` from 0 to 1); without it, the earlier snapshot is held. */
  interpolate?(a: StateOf<T>, b: StateOf<T>, f: number, c: ConfigOf<T>): StateOf<T>;
  /** Built after all others, e.g. a conveyor whose products hang from the carriers the robots provide. */
  late?: boolean;
  /** Order of its origin in measure mode, lower first; default 2. */
  originRank?: number;
}

/** One gripper of a robot (one per mover for XTS kinematics): where its fingers hang and whether it is faulted. */
export type GripperSource = { moverId: number; flange: Frame; states: FingerState[]; faulted: boolean };

export const MM = 1 / 1000;

/** How far above its anchor a fault label hangs, mm. */
export const LABEL_LIFT = {
  conveyor: 150,
  delta: 250,
  track: 300,
  gantryMover: 200,
  loopMover: 150,
  module: 150,
  cartesian: 200,
  body: 150,
  tcpLimitArea: 100,
};

/** An MCS point lifted by the given height along MCS Z. */
export function lifted(p: Vec3, height: number): Vec3 {
  return [p[0], p[1], p[2] + height];
}

/** An XTS component as recordings made before protocol 12 hold it, without track modules: drawn without a track. */
export function withModules<T extends { modules: TrackModule[] }>(c: T): T {
  return c.modules ? c : { ...c, modules: [] };
}

/** Left (local +Y) and right edge of a belt of the given width. */
export function sides(width: number): [string, number][] {
  return [
    ["left", width / 2],
    ["right", -width / 2],
  ];
}

export type SnapOwner = ReturnType<typeof snapOwner>;

/** A component's origin shift as a vector in its local frame. */
export function shiftOf(c: { originShift: Position }): Vec3 {
  return [c.originShift.x, c.originShift.y, c.originShift.z];
}

/** The frame of a component's coordinate system: its pose moved by its origin shift (no rotation). */
export function originFrame(c: { pose: Pose; originShift: Position }): Frame {
  return child(frameFromPose(c.pose), shiftOf(c));
}

/**
 * Creates the snap points of one component. Points are given in the frame of its pose (`frame`); their local
 * measuring coordinates are in its coordinate system, i.e. from its shifted origin.
 */
export function snapOwner(component: { id: number; name: string; originShift: Position }, frame: Frame) {
  const system = child(frame, shiftOf(component));
  const make = (label: string, mcs: Vec3, layer: SnapLayer, moving: boolean): SnapPoint => ({
    key: `${component.id}:${label}`,
    label,
    mcs,
    position: toRenderer(mcs),
    local: { componentId: component.id, componentName: component.name, point: toLocal(system, mcs) },
    layer,
    moving,
  });
  return {
    /** A point given in the frame of the component's pose. */
    at: (label: string, local: Vec3, layer: SnapLayer = "structure", moving = false) =>
      make(label, toMcs(frame, local), layer, moving),
    /** A point given in the MCS. */
    atMcs: (label: string, mcs: Vec3, layer: SnapLayer = "structure", moving = false) => make(label, mcs, layer, moving),
  };
}

/** One axis of a box: its two bounds with their names, or a single unnamed bound when the box is flat along it. */
export type Extent = [string | null, number][];

export function extent(min: number, max: number, minName: string, maxName: string): Extent {
  return min === max ? [[null, min]] : [[minName, min], [maxName, max]];
}

/**
 * Corner snap points of a box in a component's frame, named `<prefix> · <z>, <y>, <x>`; along an axis the box is flat
 * in, its corners exist once and leave that axis's name out.
 */
export function boxCorners(
  owner: ReturnType<typeof snapOwner>,
  prefix: string,
  layer: SnapLayer,
  [xs, ys, zs]: [Extent, Extent, Extent],
  moving = false,
): SnapPoint[] {
  const points: SnapPoint[] = [];
  for (const [zName, zc] of zs) {
    for (const [yName, yc] of ys) {
      for (const [xName, xc] of xs) {
        const name = [zName, yName, xName].filter((n) => n !== null).join(", ");
        points.push(owner.at(`${prefix} · ${name}`, [xc, yc, zc], layer, moving));
      }
    }
  }
  return points;
}

/** Thickness of a drawn box area along an axis it is flat in, mm, so it is drawn as a flat box. */
const FLAT_AREA = 1;

/** Size of a box area in metres from its extents in mm, at least FLAT_AREA thick along every axis. */
export function flatBoxSize(sizeMm: Vec3): Vec3 {
  return sizeMm.map((v) => Math.max(v, FLAT_AREA) * MM) as Vec3;
}

export const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** Interpolate degrees along the shorter way, so 179° → −179° passes through 180°, not 0°. */
function lerpAngle(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * f;
}

/** Interpolate a position on a closed track of the given perimeter along the shorter way. */
export function lerpWrapped(a: number, b: number, f: number, perimeter: number): number {
  if (perimeter <= 0) return lerp(a, b, f);
  const d = ((((b - a) % perimeter) + 1.5 * perimeter) % perimeter) - 0.5 * perimeter;
  return a + d * f;
}

export function lerpPosition(a: Position, b: Position, f: number): Position {
  return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f) };
}

/** Positions linearly, each angle along the shorter way. */
function lerpPose(a: Pose, b: Pose, f: number): Pose {
  return {
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    z: lerp(a.z, b.z, f),
    rx: lerpAngle(a.rx, b.rx, f),
    ry: lerpAngle(a.ry, b.ry, f),
    rz: lerpAngle(a.rz, b.rz, f),
  };
}

/** Finger states by index; the active flag is discrete and taken from the earlier snapshot. */
export function lerpFingers(a: FingerState[], b: FingerState[], f: number): FingerState[] {
  return a.map((s, i) => {
    const n = b[i];
    return n ? { ...s, pose: lerpPose(s.pose, n.pose, f) } : s;
  });
}

/** Whether a belt coordinate (mm from the conveyor's shifted origin) lies between the belt start and end. */
export function onBelt(belt: ConveyorConfig, beltCoordinate: number): boolean {
  const fromStart = belt.originShift.x + beltCoordinate;
  return fromStart >= 0 && fromStart <= belt.length;
}

/**
 * Where a picked product hangs, as a key of the build context's carriers: a robot's gripper flange (mover 0 for a
 * robot without movers) or, with `finger`, one finger's grip point.
 */
export const carrierKey = (robotId: number, moverId: number, finger?: number): string =>
  finger === undefined ? `${robotId}:${moverId}` : `${robotId}:${moverId}:${finger}`;
