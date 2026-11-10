import {
  trackPoints,
  type CartesianConfig,
  type CartesianState,
  type ComponentConfig,
  type ComponentState,
  type ConveyorConfig,
  type ConveyorState,
  type Fault,
  type LimitArea,
  type Product,
  type TrackPoint,
  type XtsGantryConfig,
} from "@rpp/protocol";
import type { SourceInfo } from "./sources";
import {
  apply,
  boxInside,
  frameFromPose,
  orient,
  orientedOverlap,
  rotZ,
  toLocal,
  type Frame,
  type FrameBox,
  type Vec3,
} from "./scene/frames";

/**
 * Rules about the machine that the 3D scene, the timeline, the product history, the metrics and the inspector all
 * follow, so that they agree: how a fault reads, where a product is and when it is missed, what a component is called.
 */

/** The message to show for a fault; the PLC may leave it empty. */
export function faultText(fault: Fault | null | undefined): string | null {
  return fault ? fault.message || "Fault" : null;
}

/** How far along the belt a product is now, mm from the conveyor's pose along its conveying direction. */
export function productBeltX(c: ConveyorConfig, state: ConveyorState, p: Product): number {
  // The latch pose is in the conveyor's coordinate system, which lies at the origin shift from its pose.
  return c.originShift.x + p.latchPose.x + (state.beltPosition - p.latchBeltPosition);
}

/**
 * A product that has passed the belt end without being picked or placed. Rejected products pass the end on purpose
 * and are not missed.
 */
export function isMissed(c: ConveyorConfig, state: ConveyorState, p: Product): boolean {
  return p.state !== "picked" && p.state !== "placed" && p.state !== "rejected" && productBeltX(c, state, p) > c.length;
}

/** A component's name from its source's config; `fallback` (default `#id`) when the config does not list it. */
export function componentName(source: SourceInfo | undefined, id: number, fallback = `#${id}`): string {
  return source?.config?.components.find((c) => c.id === id)?.name ?? fallback;
}

/** One entry of a list in a state, by the list's name: "movers" → "mover", "modules" → "module". */
export function singular(list: string): string {
  return list.endsWith("s") ? list.slice(0, -1) : list;
}

/** A robot's TCP limit area where its TCP (an XTS gantry: one mover's gripper flange) is now. */
export interface TcpLimitBox extends FrameBox {
  robotId: number;
  /** The XTS gantry mover it belongs to; 0 for a robot without movers. */
  moverId: number;
  /** "Delta 1", "IDH mover 2". */
  name: string;
}

/** A robot that may have a limit area and a TCP limit area. */
type LimitedRobot = Extract<ComponentConfig, { limitArea: unknown }>;

const isLimitedRobot = (c: ComponentConfig): c is LimitedRobot => "limitArea" in c;

/** The box of a limit area in a robot's frame, moved by `at` (mm); bounds in any order. */
function boxOf(frame: Frame, a: LimitArea, at: Vec3 = [0, 0, 0]): FrameBox {
  const pairs: [number, number][] = [
    [a.xMin, a.xMax],
    [a.yMin, a.yMax],
    [a.zMin, a.zMax],
  ];
  return {
    frame,
    min: pairs.map(([lo, hi], i) => Math.min(lo, hi) + at[i]!) as Vec3,
    max: pairs.map(([lo, hi], i) => Math.max(lo, hi) + at[i]!) as Vec3,
  };
}

/**
 * A gantry mover's gripper flange in the gantry's frame: on the track (lifted by the common Z axis) at its position,
 * the X axis turned with the track there. The scene draws the flange here too.
 */
export function gantryFlange(
  c: XtsGantryConfig,
  pointAt: (s: number) => TrackPoint,
  z: number,
  m: { position: number; x: number },
): Vec3 {
  const p = pointAt(m.position);
  // The track's u runs along +Y and its v along −X; a mover's X axis is the track's right, turned with its heading.
  const arm = apply(rotZ(p.heading), [m.x + c.toolOffsetX, 0, c.toolOffsetZ]);
  return [-p.v + arm[0], p.u + arm[1], z + arm[2]];
}

/**
 * A Cartesian robot's flange in its frame: an axis it does not have stays put (no Y: on the beam's line; no Z: at
 * `zMin`). The scene draws the flange here too.
 */
export function cartesianFlange(c: CartesianConfig, state: CartesianState): Vec3 {
  return [state.x, c.axes === "xz" ? 0 : state.y, c.axes === "xy" ? c.zMin : state.z];
}

/** One TCP of a robot in its frame; `moverId` 0 for a robot without movers. */
interface RobotTcp {
  moverId: number;
  tcp: Vec3;
}

type LimitedRobotType = LimitedRobot["type"];

/**
 * Where the TCPs of each robot type that may have a limit area lie in its frame. A new such type needs an entry (the
 * compiler asks for it). The XTS gantry and Cartesian kits draw their flange from the same rule (`gantryFlange`,
 * `cartesianFlange`), so drawn flange and checked TCP agree; the Delta reports its TCP in the MCS, which both take as is.
 */
const ROBOT_TCPS: {
  [T in LimitedRobotType]: (c: Extract<LimitedRobot, { type: T }>, state: Extract<ComponentState, { type: T }>) => RobotTcp[];
} = {
  delta: (c, state) => {
    const t = state.actualTcp;
    return [{ moverId: 0, tcp: toLocal(frameFromPose(c.pose), [t.x, t.y, t.z]) }];
  },
  cartesian: (c, state) => [{ moverId: 0, tcp: cartesianFlange(c, state) }],
  xtsGantry: (c, state) => {
    // Recordings made before protocol 12 have no track modules: the track runs straight along +Y.
    const pointAt = trackPoints(c.modules ?? [], false);
    return state.movers.map((m) => ({ moverId: m.id, tcp: gantryFlange(c, pointAt, state.z, m) }));
  },
};

/** Every TCP of a robot in its frame: one per gantry mover (by id), else one with mover 0. */
function robotTcps(c: LimitedRobot, state: ComponentState): RobotTcp[] {
  if (state.type !== c.type) return [];
  return (ROBOT_TCPS[c.type] as (c: LimitedRobot, state: ComponentState) => RobotTcp[])(c, state);
}

/**
 * The TCP limit areas of a source's robots where their TCPs are now (`states` by component id). A robot without a
 * state has no TCP yet; a config made before protocol 19 has no TCP limit areas.
 */
export function tcpLimitBoxes(
  components: readonly ComponentConfig[],
  states: ReadonlyMap<number, ComponentState>,
): TcpLimitBox[] {
  const boxes: TcpLimitBox[] = [];
  for (const c of components) {
    if (!isLimitedRobot(c) || !c.tcpLimitArea) continue;
    const state = states.get(c.id);
    if (!state) continue;
    const frame = frameFromPose(c.pose);
    for (const { moverId, tcp } of robotTcps(c, state)) {
      const name = moverId ? `${c.name} mover ${moverId}` : c.name;
      boxes.push({ robotId: c.id, moverId, name, ...boxOf(frame, c.tcpLimitArea, tcp) });
    }
  }
  return boxes;
}

/** One of the boxes a limit violation is about: a robot's limit area (`moverId` null) or a TCP limit area. */
export interface LimitBoxRef {
  robotId: number;
  moverId: number | null;
}

/**
 * A TCP limit area that overlaps another robot's limit area or another TCP limit area (also another mover's of the same
 * gantry), or that leaves its own robot's limit area. Boxes that only touch do not overlap.
 */
export interface LimitViolation {
  /** Stable while the violation lasts, e.g. "20:0|limit:50". */
  key: string;
  /** The TCP limit area. */
  tcp: { robotId: number; moverId: number };
  /** The box it overlaps or, when it leaves it, its own robot's limit area. */
  other: LimitBoxRef;
  /** "Delta 1 TCP limit area overlaps the limit area of Cartesian", "IDH mover 2 TCP limit area leaves the limit area of IDH". */
  text: string;
}

/** A box ref as a key: "50:limit" for a limit area, "30:2" for a TCP limit area. */
export const limitBoxKey = (ref: LimitBoxRef): string => `${ref.robotId}:${ref.moverId ?? "limit"}`;

/**
 * The limit violations of one source's robots with their TCPs where `states` (by component id) put them, and the TCP
 * limit areas they were found from. Robots of different sources never meet: each source has its own space.
 */
export function limitViolations(
  components: readonly ComponentConfig[],
  states: ReadonlyMap<number, ComponentState>,
): { boxes: TcpLimitBox[]; violations: LimitViolation[] } {
  const boxes = tcpLimitBoxes(components, states);
  const violations: LimitViolation[] = [];
  // Most machines have no TCP limit areas: nothing to check. Else each box is prepared for the tests once.
  if (boxes.length === 0) return { boxes, violations };
  const limits = components.filter(isLimitedRobot).flatMap((c) => {
    if (!c.limitArea) return [];
    const box = boxOf(frameFromPose(c.pose), c.limitArea);
    return [{ robotId: c.id, name: c.name, box, oriented: orient(box) }];
  });
  const oriented = boxes.map(orient);
  const add = (t: TcpLimitBox, other: LimitBoxRef, text: string) =>
    violations.push({
      key: `${limitBoxKey(t)}|${limitBoxKey(other)}`,
      tcp: { robotId: t.robotId, moverId: t.moverId },
      other,
      text: `${t.name} TCP limit area ${text}`,
    });
  boxes.forEach((t, i) => {
    const p = oriented[i]!;
    for (const l of limits) {
      if (l.robotId !== t.robotId) {
        if (orientedOverlap(p, l.oriented)) {
          add(t, { robotId: l.robotId, moverId: null }, `overlaps the limit area of ${l.name}`);
        }
      } else if (!boxInside(t, l.box)) {
        add(t, { robotId: l.robotId, moverId: null }, `leaves the limit area of ${l.name}`);
      }
    }
    // Each pair of TCP limit areas once.
    for (let j = i + 1; j < boxes.length; j++) {
      const u = boxes[j]!;
      if (orientedOverlap(p, oriented[j]!)) {
        add(t, { robotId: u.robotId, moverId: u.moverId }, `overlaps the TCP limit area of ${u.name}`);
      }
    }
  });
  return { boxes, violations };
}
