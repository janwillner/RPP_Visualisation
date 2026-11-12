import type {
  BodyRole,
  BodyShape,
  ComponentConfig,
  ComponentState,
  ComponentType,
  ConfigMessage,
  ConveyorConfig,
  Product,
  ProductShape,
  ProductState,
  StateMessage,
  Zone,
} from "@rpp/protocol";
import {
  child,
  type Frame,
  frameFromPose,
  fromRenderer,
  rotZ,
  toMcs,
  toRenderer,
  toRendererTransform,
  type Transform,
  type Vec3,
} from "./frames";
import { limitBoxKey, limitViolations, tcpLimitBoxes, zoneSides, zoneWarnings } from "../machine-facts";
import { isGrouped } from "./product-groups";
import {
  boxCorners,
  type BuildContext,
  carrierKey,
  type ComponentKit,
  extent,
  type Extent,
  flatBoxSize,
  LABEL_LIFT,
  lifted,
  MM,
  originFrame,
  snapOwner,
} from "./kits/kit";
import { conveyorKit } from "./kits/conveyor";
import { deltaKit } from "./kits/delta";
import { xtsGantryKit } from "./kits/xts-gantry";
import { xtsLoopKit } from "./kits/xts-loop";
import { cartesianKit } from "./kits/cartesian";
import { bodyKit } from "./kits/bodies";

/**
 * The scene model: everything the renderer draws, in the renderer frame (metres, Y up).
 *
 * Object-local axes follow the same mapping as the world: local +X = MCS local +X (e.g. conveying
 * direction), local +Y = MCS local up, local +Z = MCS local −Y.
 */
export type { Transform, Vec3 };

/** A point picked in the renderer (metres, Y up) as MCS coordinates (mm, Z up). */
export const rendererToMcs = (point: Vec3): Vec3 => fromRenderer(point);

/** An MCS point (mm, Z up) in renderer coordinates (metres, Y up). */
export const mcsToRenderer = (point: Vec3): Vec3 => toRenderer(point);

export interface SceneConveyor {
  id: number;
  name: string;
  /** Belt start on the belt surface; the belt extends along local +X. */
  transform: Transform;
  length: number;
  width: number;
  /**
   * The conveyor's X axis on the belt surface, metres in the belt's frame (X along the belt, Y across it): drawn from
   * a ball at its shifted origin to the conveying direction arrow at the belt end.
   */
  axis: { originX: number; originY: number };
  /** False for a conveyor without a body: its belt is not drawn, only its axis, products and zones. */
  body: boolean;
  /** Fault message to show, null = no fault. */
  fault: string | null;
}

export interface Size {
  length: number;
  width: number;
  height: number;
}

/** How a product is drawn: on the belt, carried at a TCP, as an empty outline, or flagged as missed. */
export type ProductDisplay = "normal" | "atTcp" | "placeholder" | "missed";

export interface SceneProduct {
  /** Unique per drawn object (a picked product yields an at-TCP box plus a placeholder). */
  key: string;
  productId: number;
  conveyorId: number;
  display: ProductDisplay;
  state: ProductState;
  /** The product mark the PLC gave it, 1 to `MAX_MARKS`; 0 = none, also for a number out of range. */
  mark: number;
  /** Centre of the product. Local +X along the product length, local +Y up. */
  transform: Transform;
  /** MCS frame (mm) at the product's bottom centre; local +X along its length, local +Z up through the product. */
  bottom: Frame;
  size: Size;
  /** Its solid: for a cylinder, length and width are the two diameters. */
  shape: ProductShape;
  /** Metres, rounded vertical edges of a rounded box; 0 otherwise. */
  cornerRadius: number;
  /** Register entry as reported by the PLC. */
  raw: Product;
}

export interface SceneDelta {
  id: number;
  name: string;
  /** Base centre; local axes as in the robot's frame. */
  base: Transform;
  /** Base centre to shoulder joint, metres. */
  baseRadius: number;
  /** Effector centre to lower-arm joint, metres. */
  effectorRadius: number;
  /** World positions, one per arm. */
  shoulders: Vec3[];
  elbows: Vec3[];

  /** Lower-arm joints on the effector; empty when the TCP is not reachable. */
  effectorJoints: Vec3[];
  /** Effector plate at the actual TCP, turned with the base like its arm joints (the flange frame keeps the MCS axes). */
  effector: Transform | null;
  /** False when the arms cannot reach the reported TCP (the effector is still drawn at the TCP). */
  reachable: boolean;
  /** TCPs reported by the PLC; null before the first state arrives. */
  actualTcp: Vec3 | null;
  setpointTcp: Vec3 | null;
  /** Upper-arm angles in degrees computed from the TCP (angle convention of the contract); empty if unreachable. */
  angles: number[];
  /** Fault message to show, null = no fault. */
  fault: string | null;
}

export interface SceneWorkingArea {
  robotId: number;
  /** Robot base frame; the cylinder axis is local +Y, heights relative to the base. */
  transform: Transform;
  radius: number;
  zMin: number;
  zMax: number;
  coneHeight: number;
  coneBottomRadius: number;
}

export interface SceneZone {
  /** The component the zone belongs to: a robot, a detector. */
  componentId: number;
  conveyorId: number;
  /** Centre of the zone on the belt surface; extends along local +X. */
  transform: Transform;
  length: number;
  width: number;
  /** The component's conveyor coordinate system (CCS) on the belt's centre line, oriented like the belt; drawn across the zone. */
  ccs: Transform;
  /**
   * Part of the zone in which the robot may still allocate products: from the zone start up to the allocation limit
   * (`end − allocationOffset`). Null when the zone has no allocation limit.
   */
  allocation: SceneAllocation | null;
}

/** Allocation area of a zone along the zone's local +X, metres from the zone centre. */
export interface SceneAllocation {
  /** Centre of the allocation area. */
  centre: number;
  length: number;
  /** Allocation limit, where the robot stops allocating products. */
  limit: number;
}

export interface SceneGantryMover {
  id: number;
  /** Mover centre on the track. */
  carriage: Vec3;
  /** End of the X arm, straight above the gripper flange. */
  armEnd: Vec3;
  /** Gripper flange, turned with the gantry; local +Y up. */
  tip: Transform;
  /** The mover's gripper flag; false when fingers are configured (they show their own state). */
  gripperActive: boolean;
  /** Fault message of this mover, null = none. */
  fault: string | null;
}

/**
 * One track module of an XTS gantry or loop, drawn inside its component's track group (the gantry's `track`, the
 * loop's `base`). Module frame: origin at the module's start on the track line, local MCS +X along the track,
 * +Y to its left, +Z the normal of the track's plane.
 */
export interface SceneTrackModule {
  key: string;
  /** 1-based, in the order movers run along the track. */
  index: number;
  /** Relative to the track group. */
  transform: Transform;
  /** Metres along the track line. */
  length: number;
  /** Radius of a curve module's track line, metres; 0 for a straight one. */
  radius: number;
  /** +1 curves to the left (local +Y), −1 to the right, 0 straight. */
  turn: number;
  /** Cross-section in the module frame, metres: from–to across the track (local Y) and along the normal (local Z). */
  across: [number, number];
  depth: [number, number];
  /** Fault message of this module, null = none. */
  fault: string | null;
}

export interface SceneGantry {
  id: number;
  name: string;
  /** Track start at the current Z position; the track runs along local MCS +Y (renderer local −Z). */
  track: Transform;
  modules: SceneTrackModule[];
  moverLength: number;
  moverWidth: number;
  movers: SceneGantryMover[];
  /** Fault message of the whole gantry, null = none. */
  fault: string | null;
}

/** An axis-aligned box in a component's frame, e.g. the reachable volume of an XTS gantry or a Cartesian robot. */
export interface SceneBoxArea {
  robotId: number;
  /** Box centre. */
  transform: Transform;
  /** Extent along the local MCS X, Y and Z axes, metres. */
  size: Vec3;
}

/** A robot's limit area; violated while a TCP limit area overlaps it or leaves it. */
export interface SceneLimitArea extends SceneBoxArea {
  violated: boolean;
}

/**
 * A box around a robot's TCP (an XTS gantry: around each mover's gripper flange), along the axes of the robot's frame;
 * violated while it overlaps another robot's limit area or another TCP limit area, or leaves its robot's limit area.
 */
export interface SceneTcpLimitArea extends SceneLimitArea {
  /** `robotId:moverId`, stable across frames. */
  key: string;
  /** 0 for a robot without movers. */
  moverId: number;
}

export interface SceneLoopMover {
  id: number;
  /** Mover on the track; local +X along the track tangent, local MCS −Z (renderer −Y) outwards. */
  transform: Transform;
  /** Tool point (gripper flange), where a carried product without finger hangs. */
  tool: Vec3;
  /** Fault message of this mover, null = none. */
  fault: string | null;
}

export interface SceneLoop {
  id: number;
  name: string;
  /** Start of the first module; the loop lies in the local X-Z plane. */
  base: Transform;
  modules: SceneTrackModule[];
  /** Where the name label hangs, relative to `base`: the middle of the loop. */
  label: Vec3;
  moverLength: number;
  moverWidth: number;
  movers: SceneLoopMover[];
  /** Fault message of the whole loop, null = none. */
  fault: string | null;
}

/** A solid box part of a component. */
export interface SceneBox {
  key: string;
  /** Box centre. */
  transform: Transform;
  /** Extent along the local MCS X, Y and Z axes, metres. */
  size: Vec3;
}

export type CartesianPartKey = "rail left" | "rail right" | "bridge" | "beam" | "carriage" | "column";

export interface SceneCartesian {
  id: number;
  name: string;
  /** Rails (static), bridge, carriage and column (moving with the axes); without a Y axis a static beam instead of rails and bridge. */
  parts: (SceneBox & { key: CartesianPartKey })[];
  /** Gripper flange at the column's lower end, turned with the robot. Null before the first state. */
  flange: Transform | null;
  /** The robot's gripper flag; false when fingers are configured (they show their own state). */
  gripperActive: boolean;
  /** Actual axis values as reported; null before the first state. */
  axes: { x: number; y: number; z: number } | null;
  /** Fault message to show, null = no fault. */
  fault: string | null;
}

/**
 * One body of a component drawn from what the PLC describes (a detector's housing, beam, field of view), without
 * knowing what the component is.
 */
export interface SceneBody {
  /** `componentId:index`, stable across frames. */
  key: string;
  componentId: number;
  shape: BodyShape;
  role: BodyRole;
  /** Bottom centre; the body extends along local +Y (renderer), MCS local +Z. */
  transform: Transform;
  /** Metres; for a cylinder, length and width are its two diameters. */
  size: Size;
  /** Metres, a frustum's top face. */
  top: { length: number; width: number };
  /** Its state says so, e.g. an interrupted light barrier: an overlay then lights up. */
  active: boolean;
  /** Its component is in a fault. */
  faulted: boolean;
}

/** One gripper finger: a cylinder hanging from its frame's origin (top centre) along its local −Z. */
export interface SceneFinger {
  /** `robotId:moverId:finger`, stable across frames. */
  key: string;
  robotId: number;
  /** 0 for a robot without movers. */
  moverId: number;
  /** 1-based, as `fingerId` of a product. */
  index: number;
  /** Top centre; the cylinder extends along local renderer −Y (MCS local −Z). */
  transform: Transform;
  diameter: number;
  height: number;
  active: boolean;
  /** The gripper flange the finger belongs to, for the connecting rod. */
  flange: Vec3;
  /** Its robot or its mover is in a fault. */
  faulted: boolean;
}

/** Which layer toggle a snap point belongs to; "structure" is always shown. */
export type SnapLayer = "structure" | "zones" | "workingAreas" | "limitAreas";

/** A characteristic point of a component that measure mode can snap to. */
export interface SnapPoint {
  /** Stable across frames, e.g. for hover tracking. */
  key: string;
  label: string;
  /** Exact MCS position, mm. */
  mcs: Vec3;
  /** Renderer position, metres. */
  position: Vec3;
  /** The same point in the frame of the component it belongs to, mm. */
  local: { componentId: number; componentName: string; point: Vec3 };
  layer: SnapLayer;
  /** Moves with the state (products, TCP); drawn only when highlighted. */
  moving: boolean;
}

/** Origin frame of a component, shown in measure mode. */
export interface SceneOrigin {
  componentId: number;
  name: string;
  transform: Transform;
}

/** A fault message drawn above a faulted component, mover or track module. */
export interface SceneFaultLabel {
  key: string;
  componentId: number;
  /** The faulted part, e.g. "Mover 2" or "Module 9"; null for the component itself. */
  part: string | null;
  message: string;
  /** Renderer frame, metres: where the label hangs. */
  position: Vec3;
  /** A limit violation the web found, not a fault the PLC reports. */
  limit: boolean;
}

/**
 * Active faults of one component (its own first, then its movers' and track modules'), for the component list, and
 * the limit violations it takes part in.
 */
export interface ComponentFaults {
  componentId: number;
  /** Faults the PLC reports. */
  messages: string[];
  /** Limit violations found from the TCP limit areas, e.g. "Delta 1 TCP limit area leaves the limit area of Delta 1". */
  limitViolations: string[];
}

export interface SceneModel {
  conveyors: SceneConveyor[];
  products: SceneProduct[];
  deltas: SceneDelta[];
  workingAreas: SceneWorkingArea[];
  zones: SceneZone[];
  gantries: SceneGantry[];
  boxAreas: SceneBoxArea[];
  /** Limit areas (Delta, XTS gantry, Cartesian): boxes in the robot frame that further restrict the working area. */
  limitAreas: SceneLimitArea[];
  /** TCP limit areas: boxes around the robots' TCPs. */
  tcpLimitAreas: SceneTcpLimitArea[];
  loops: SceneLoop[];
  cartesians: SceneCartesian[];
  /** Bodies of the components drawn from their PLC description, e.g. detectors. */
  bodies: SceneBody[];
  fingers: SceneFinger[];
  snapPoints: SnapPoint[];
  origins: SceneOrigin[];
  faultLabels: SceneFaultLabel[];
  /** Every component with an active fault, hidden ones included. */
  faults: ComponentFaults[];
  /** Inconsistencies in the configuration, e.g. a zone referencing an unknown conveyor. */
  warnings: string[];
}

/** What the scene needs to know about one kind of part, whatever component adds it. */
interface PartKind<T> {
  /** The component whose hiding hides the part; none: the part is never dropped for a hidden component. */
  owner?: (part: T) => number;
  /** What of the part changes the drawn objects (not just their transforms); none, or undefined: nothing does. */
  structure?: (part: T) => string | undefined;
  /** Its key among the parts of its kind, for the kinds the 3D view looks up every frame (`SourceFrame.part`). */
  key?: (part: T) => string | number;
}

/**
 * Every kind of part a scene holds, the place a new kind is added: the empty scene, dropping hidden components and the
 * structural signature the 3D view re-renders on all follow from it.
 */
export const SCENE_PARTS: { [K in keyof SceneModel]: PartKind<SceneModel[K][number]> } = {
  conveyors: {
    owner: (c) => c.id,
    structure: (c) => `${c.id}:${c.length}:${c.width}:${c.body}:${c.axis.originX}:${c.axis.originY}`,
  },
  // Products on the belt are drawn in groups: only a new or larger group counts (see `ProductGroups`). The few drawn
  // one by one (placeholders, carried products) count each.
  products: { owner: (p) => p.conveyorId, structure: (p) => (isGrouped(p) ? undefined : `${p.key}:${p.state}:${p.mark}`) },
  deltas: { owner: (d) => d.id, key: (d) => d.id, structure: (d) => `${d.id}:${d.baseRadius}:${d.effectorRadius}` },
  gantries: {
    owner: (g) => g.id,
    key: (g) => g.id,
    structure: (g) => `${g.id}:${trackSignature(g.modules)}:${g.movers.map((x) => x.id).join("/")}`,
  },
  loops: {
    owner: (l) => l.id,
    key: (l) => l.id,
    structure: (l) => `${l.id}:${trackSignature(l.modules)}:${l.movers.map((x) => x.id).join("/")}`,
  },
  cartesians: {
    owner: (c) => c.id,
    key: (c) => c.id,
    structure: (c) => `${c.id}:${c.parts.map((p) => p.size.join("/")).join("/")}:${c.flange ? 1 : 0}`,
  },
  bodies: {
    owner: (b) => b.componentId,
    key: (b) => b.key,
    structure: (b) => `${b.key}:${b.shape}:${b.role}:${b.size.length}/${b.size.width}/${b.size.height}`,
  },
  fingers: { owner: (f) => f.robotId, key: (f) => f.key, structure: (f) => `${f.key}:${f.diameter}:${f.height}` },
  boxAreas: { owner: (a) => a.robotId, structure: (a) => `${a.robotId}:${a.size.join("/")}` },
  // A violation changes the colour.
  limitAreas: { owner: (a) => a.robotId, structure: (a) => `${a.robotId}:${a.size.join("/")}:${a.violated}` },
  tcpLimitAreas: {
    owner: (a) => a.robotId,
    key: (a) => a.key,
    structure: (a) => `${a.key}:${a.size.join("/")}:${a.violated}`,
  },
  workingAreas: {
    owner: (a) => a.robotId,
    structure: (a) => `${a.robotId}:${a.radius}:${a.zMin}:${a.zMax}:${a.coneHeight}:${a.coneBottomRadius}`,
  },
  // Already left out for hidden components and conveyors when they are built.
  zones: {
    structure: (w) => `${w.componentId}:${w.conveyorId}:${w.length}:${w.width}:${w.allocation?.length ?? 0}`,
  },
  // Faults change colours and labels. Every fault of a shown component or mover has exactly one label, so the labels
  // also stand for the red tint of the parts.
  faultLabels: { owner: (l) => l.componentId, key: (l) => l.key, structure: (l) => `${l.key}:${l.message}` },
  snapPoints: { owner: (p) => p.local.componentId, structure: (p) => (p.moving ? undefined : p.key) },
  origins: { owner: (o) => o.componentId },
  // Every component with an active fault, hidden ones included.
  faults: {},
  warnings: {},
};

const PART_KINDS = Object.entries(SCENE_PARTS) as [keyof SceneModel, PartKind<unknown>][];

/** The structural signature of a scene: it changes when the set or shape of what is drawn changes. */
export function sceneStructure(scene: SceneModel): string {
  return PART_KINDS.map(([kind, { structure }]) => {
    if (!structure) return "";
    const keys: string[] = [];
    for (const part of scene[kind] as unknown[]) {
      const key = structure(part);
      if (key !== undefined) keys.push(key);
    }
    return keys.join(",");
  }).join("|");
}

/** What of a track's modules changes their meshes. */
export function trackSignature(modules: readonly SceneTrackModule[]): string {
  return modules.map((m) => `${m.length}/${m.turn}/${m.across.join("/")}/${m.depth.join("/")}`).join(";");
}

/** How a scene is built beyond its data. */
export interface SceneOptions {
  /**
   * Snap points that only measure mode needs, default true: on every product (bottom centre, corners or outline) and
   * on the corners of the TCP limit areas. Thousands of products give tens of thousands of points, and the TCP limit
   * areas move every frame, so the 3D view asks for them only while measuring.
   */
  measureSnapPoints?: boolean;
  /**
   * Look for limit violations; default true. Off for a source that is offline: its last state says nothing about where
   * its robots are now. Its TCP limit areas are still drawn.
   */
  checkLimits?: boolean;
}

/**
 * Every component type the scene knows. A new component type needs its kit in a module in `kits/`, one entry here
 * and, for a new kind of part, a mesh in a module in `views/` with its entry in `PART_VIEWS` (`SceneView.tsx`).
 */
const KITS: { [T in ComponentType]: ComponentKit<T> } = {
  conveyor: conveyorKit,
  delta: deltaKit,
  xtsGantry: xtsGantryKit,
  xtsLoop: xtsLoopKit,
  cartesian: cartesianKit,
  vision: bodyKit(),
  sensor: bodyKit(),
  station: bodyKit(),
};

/** The kit of a component type, typed for the whole union: each kit only ever gets configs and states of its type. */
const kitOf = (type: ComponentType) => KITS[type] as unknown as ComponentKit<ComponentType>;

/** A scene with nothing in it. */
export function emptyScene(): SceneModel {
  return Object.fromEntries(PART_KINDS.map(([kind]) => [kind, []])) as unknown as SceneModel;
}

/**
 * `hidden`: manifest ids of components the user has hidden. A hidden component contributes nothing to the scene:
 * no geometry, zones, areas, snap points or origin; a hidden conveyor also hides its products and the zones on it.
 * Products of a visible conveyor carried by a hidden robot are still drawn where it carries them.
 */
export function buildScene(
  config: ConfigMessage | undefined,
  snapshots: readonly StateMessage[],
  renderTime: number,
  hidden: ReadonlySet<number> = new Set(),
  options: SceneOptions = {},
): SceneModel {
  const components = config?.components ?? [];
  const states = sampleStates(snapshots, renderTime, new Map(components.map((c) => [c.id, c])));
  const scene = emptyScene();
  const { snapPoints, zones, warnings, faultLabels, faults } = scene;
  const conveyorConfigs = new Map<number, ConveyorConfig>();
  for (const c of components) if (c.type === "conveyor") conveyorConfigs.set(c.id, c);
  /** A component's entry in the fault list, made on its first fault or limit violation. */
  const faultsOf = (componentId: number): ComponentFaults => {
    let entry = faults.find((f) => f.componentId === componentId);
    if (!entry) faults.push((entry = { componentId, messages: [], limitViolations: [] }));
    return entry;
  };

  const ctx: BuildContext = {
    scene,
    measureSnapPoints: options.measureSnapPoints ?? true,
    carriers: new Map(),
    warn: (message) => warnings.push(message),
    addFault(componentId, part, message, anchor) {
      if (message === null) return;
      const position = toRenderer(anchor);
      faultLabels.push({ key: `${componentId}:${part ?? ""}`, componentId, part, message, position, limit: false });
      faultsOf(componentId).messages.push(part ? `${part}: ${message}` : message);
    },
    addGripper(robot, grippers) {
      const owner = snapOwner(robot, frameFromPose(robot.pose));
      for (const g of grippers) {
        robot.fingers.forEach((f, i) => {
          const state = g.states[i];
          const index = i + 1;
          // A pose the application did not report: the finger hangs at its offset on the flange (ADR 0018).
          const { x, y, z, rz } = f.offset;
          const frame = state?.poseReported ? frameFromPose(state.pose) : child(g.flange, [x, y, z], rotZ(rz));
          const grip = child(frame, [0, 0, -f.height]);
          ctx.carriers.set(carrierKey(robot.id, g.moverId, index), grip);
          scene.fingers.push({
            key: `${robot.id}:${g.moverId}:${index}`,
            robotId: robot.id,
            moverId: g.moverId,
            index,
            transform: toRendererTransform(frame),
            diameter: f.diameter * MM,
            height: f.height * MM,
            active: state?.active ?? false,
            faulted: g.faulted,
            flange: toRenderer(g.flange.origin),
          });
          const name = g.moverId ? `${robot.name} · mover ${g.moverId} finger ${index}` : `${robot.name} · finger ${index}`;
          snapPoints.push(owner.atMcs(`${name} grip point`, grip.origin, "structure", true));
        });
      }
    },
    addLimitArea(c) {
      const a = c.limitArea;
      if (!a) return;
      const frame = frameFromPose(c.pose);
      scene.limitAreas.push({
        robotId: c.id,
        transform: toRendererTransform(child(frame, [(a.xMin + a.xMax) / 2, (a.yMin + a.yMax) / 2, (a.zMin + a.zMax) / 2])),
        size: flatBoxSize([a.xMax - a.xMin, a.yMax - a.yMin, a.zMax - a.zMin]),
        violated: false,
      });
      snapPoints.push(
        ...boxCorners(snapOwner(c, frame), `${c.name} limit area`, "limitAreas", [
          extent(a.xMin, a.xMax, "X min", "X max"),
          extent(a.yMin, a.yMax, "Y min", "Y max"),
          extent(a.zMin, a.zMax, "bottom", "top"),
        ]),
      );
    },
    addZones(c) {
      if (hidden.has(c.id)) return;
      for (const win of c.zones) {
        const belt = conveyorConfigs.get(win.conveyorId);
        if (!belt) {
          warnings.push(`${c.name}: zone references unknown conveyor ${win.conveyorId}`);
          continue;
        }
        if (hidden.has(belt.id)) continue;
        const beltFrame = frameFromPose(belt.pose);
        // Belt coordinates count from the conveyor's origin, which may be shifted from the belt start.
        const along = (beltCoordinate: number) => belt.originShift.x + beltCoordinate;
        const limit = allocationLimit(win);
        const zoneCentre = (win.start + win.end) / 2;
        const name = `${c.name} zone on ${belt.name}`;
        const lane = zoneLane(win, belt);
        warnings.push(...zoneWarnings(c.name, win, belt));
        const laneCentre = (lane.left + lane.right) / 2;
        zones.push({
          componentId: c.id,
          conveyorId: belt.id,
          transform: toRendererTransform(child(beltFrame, [along(zoneCentre), laneCentre, 0])),
          length: Math.abs(win.end - win.start) * MM,
          width: (lane.left - lane.right) * MM,
          ccs: toRendererTransform(child(beltFrame, [along(win.ccsOffset), laneCentre, 0])),
          allocation:
            limit === undefined
              ? null
              : {
                  centre: ((win.start + limit) / 2 - zoneCentre) * MM,
                  length: Math.abs(limit - win.start) * MM,
                  limit: (limit - zoneCentre) * MM,
                },
        });
        const owner = snapOwner(belt, beltFrame);
        for (const [side, y] of [
          ["left", lane.left],
          ["right", lane.right],
        ] as const) {
          snapPoints.push(owner.at(`${name} · start, ${side}`, [along(win.start), y, 0], "zones"));
          snapPoints.push(owner.at(`${name} · end, ${side}`, [along(win.end), y, 0], "zones"));
          if (limit !== undefined) {
            snapPoints.push(owner.at(`${name} · allocation limit, ${side}`, [along(limit), y, 0], "zones"));
          }
        }
        snapPoints.push(owner.at(`${name} · CCS`, [along(win.ccsOffset), laneCentre, 0], "zones"));
      }
    },
  };

  // Components that draw products come last: the products hang from the carriers the others provide.
  const late = (c: ComponentConfig) => kitOf(c.type).late === true;
  for (const c of [...components.filter((c) => !late(c)), ...components.filter(late)]) {
    const state = states.get(c.id);
    kitOf(c.type).build(c, state?.type === c.type ? state : undefined, ctx);
  }
  addTcpLimitAreas(scene, components, states, {
    check: options.checkLimits ?? true,
    snapPoints: options.measureSnapPoints ?? true,
    faultsOf,
  });
  // Each component's coordinate system: at its pose, moved by its origin shift.
  const rank = (c: ComponentConfig) => kitOf(c.type).originRank ?? 2;
  scene.origins = [...components]
    .sort((a, b) => rank(a) - rank(b))
    .map((c) => ({ componentId: c.id, name: c.name, transform: toRendererTransform(originFrame(c)) }));
  // Hidden components are built too (a hidden robot still carries products of a visible conveyor), then dropped.
  return withoutHidden(scene, hidden);
}

/**
 * The robots' TCP limit areas where their TCPs are now, with `snapPoints` their corners as snap points, and with
 * `check` the limit violations: the boxes involved light up, each violation is listed under every robot involved and
 * labelled above its TCP limit area.
 */
function addTcpLimitAreas(
  scene: SceneModel,
  components: readonly ComponentConfig[],
  states: ReadonlyMap<number, ComponentState>,
  options: { check: boolean; snapPoints: boolean; faultsOf: (componentId: number) => ComponentFaults },
): void {
  const { boxes, violations } = options.check
    ? limitViolations(components, states)
    : { boxes: tcpLimitBoxes(components, states), violations: [] };
  if (boxes.length === 0) return;
  const violated = new Set(violations.flatMap((v) => [limitBoxKey(v.tcp), limitBoxKey(v.other)]));
  const robots = options.snapPoints ? new Map(components.map((c) => [c.id, c])) : undefined;
  const tops = new Map<string, Vec3>();
  for (const box of boxes) {
    const { min, max, frame } = box;
    const key = limitBoxKey(box);
    const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    if (violated.has(key)) tops.set(key, lifted(toMcs(frame, [centre[0], centre[1], max[2]]), LABEL_LIFT.tcpLimitArea));
    scene.tcpLimitAreas.push({
      key,
      robotId: box.robotId,
      moverId: box.moverId,
      transform: toRendererTransform(child(frame, centre)),
      size: flatBoxSize([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
      violated: violated.has(key),
    });
    if (robots) {
      const extents: [Extent, Extent, Extent] = [
        extent(min[0], max[0], "X min", "X max"),
        extent(min[1], max[1], "Y min", "Y max"),
        extent(min[2], max[2], "bottom", "top"),
      ];
      const owner = snapOwner(robots.get(box.robotId)!, frame);
      scene.snapPoints.push(...boxCorners(owner, `${box.name} TCP limit area`, "limitAreas", extents, true));
    }
  }
  if (violated.size === 0) return;
  for (const area of scene.limitAreas) area.violated = violated.has(limitBoxKey({ robotId: area.robotId, moverId: null }));
  for (const v of violations) {
    const { robotId } = v.tcp;
    const position = toRenderer(tops.get(limitBoxKey(v.tcp))!);
    scene.faultLabels.push({ key: `${robotId}:limit:${v.key}`, componentId: robotId, part: null, message: v.text, position, limit: true });
    for (const id of new Set([robotId, v.other.robotId])) options.faultsOf(id).limitViolations.push(v.text);
  }
}

/** The scene without the parts of hidden components. */
function withoutHidden(scene: SceneModel, hidden: ReadonlySet<number>): SceneModel {
  const shown: Record<string, unknown[]> = {};
  for (const [kind, { owner }] of PART_KINDS) {
    const parts = scene[kind] as unknown[];
    shown[kind] = owner && hidden.size > 0 ? parts.filter((p) => !hidden.has(owner(p))) : parts;
  }
  return shown as unknown as SceneModel;
}

/** A component across all sources: manifest ids are unique only within one source. */
export type ComponentKey = string;
export const componentKey = (sourceId: string, id: number): ComponentKey => `${sourceId}#${id}`;

/** What one PLC source contributes to the machine scene. */
export interface SceneSource {
  sourceId: string;
  config: ConfigMessage | undefined;
  snapshots: readonly StateMessage[];
  /** On this source's own tRel axis: the PLCs' clocks are not synchronised. */
  renderTime: number;
  /** False while the gateway cannot read the PLC; its last config and state stay in the scene. */
  online: boolean;
}

export interface SourceScene {
  sourceId: string;
  online: boolean;
  /** Ids in here are the source's manifest ids. */
  scene: SceneModel;
}

export type SourcedSnapPoint = SnapPoint & { sourceId: string };
export type SourcedFaults = ComponentFaults & { sourceId: string };

export interface MachineScene {
  sources: SourceScene[];
  /** Snap points of every source; keys are unique across sources. */
  snapPoints: SourcedSnapPoint[];
  /** Component origins of every source, for measure mode. */
  origins: (SceneOrigin & { sourceId: string })[];
  /** Every component with an active fault, hidden ones and hidden sources included. */
  faults: SourcedFaults[];
}

/**
 * The scene of a machine read from several PLCs: each source is built on its own (its own timeline, its ids, its
 * references) and the results are put side by side; all sources report in the same MCS. `hidden` holds component
 * keys and source ids; a hidden source hides all of its components.
 */
export function buildMachineScene(
  sources: readonly SceneSource[],
  hidden: ReadonlySet<string>,
  options: SceneOptions = {},
): MachineScene {
  const built = sources.map(({ sourceId, config, snapshots, renderTime, online }) => {
    const ids = (config?.components ?? []).map((c) => c.id);
    const hiddenIds = new Set(hidden.has(sourceId) ? ids : ids.filter((id) => hidden.has(componentKey(sourceId, id))));
    const checkLimits = online && (options.checkLimits ?? true);
    return { sourceId, online, scene: buildScene(config, snapshots, renderTime, hiddenIds, { ...options, checkLimits }) };
  });
  return {
    sources: built,
    snapPoints: built.flatMap(({ sourceId, scene }) =>
      scene.snapPoints.map((p) => ({ ...p, key: `${sourceId}|${p.key}`, sourceId })),
    ),
    origins: built.flatMap(({ sourceId, scene }) => scene.origins.map((o) => ({ ...o, sourceId }))),
    faults: built.flatMap(({ sourceId, scene }) => scene.faults.map((f) => ({ sourceId, ...f }))),
  };
}

/**
 * Belt coordinate of a zone's allocation limit: `allocationOffset` before the zone end, against the conveying
 * direction, never beyond the zone start. Undefined when the zone has no allocation limit.
 */
function allocationLimit(zone: Zone): number | undefined {
  if (!(zone.allocationOffset > 0)) return undefined;
  const direction = zone.end >= zone.start ? 1 : -1;
  const length = Math.abs(zone.end - zone.start);
  return zone.end - direction * Math.min(zone.allocationOffset, length);
}

/**
 * A zone's sides across its belt, mm along the belt's local Y (from its pose; the belt's centre line is 0): the
 * whole belt width when `startY = endY`, else the bounds given in the conveyor's coordinate system, also where they
 * reach past the belt's sides.
 */
function zoneLane(zone: Zone, belt: ConveyorConfig): { left: number; right: number } {
  const { left, right } = zoneSides(zone, belt);
  return { left: belt.originShift.y + left, right: belt.originShift.y + right };
}

/** Snap points whose layer is currently shown. */
export function availableSnapPoints(
  points: readonly SnapPoint[],
  layers: { zones: boolean; workingAreas: boolean; limitAreas: boolean },
): SnapPoint[] {
  return points.filter((p) => p.layer === "structure" || layers[p.layer]);
}

/** Per measuring point: its signed offset along MCS X, Y and Z from the previous point (none for the first). */
export function measureChain(points: readonly Vec3[]): { delta: Vec3 | undefined }[] {
  return points.map((p, i) => {
    const prev = points[i - 1];
    return { delta: prev ? [p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]] : undefined };
  });
}

/** "X;Y;Z" with 0.1 mm, for the clipboard. */
export function formatPointCopy(p: Vec3): string {
  return p.map((v) => v.toFixed(1)).join(";");
}

/** All measuring points as CSV (semicolon separated), with the offsets along X, Y and Z from the previous point. */
export function pointsCsv(points: readonly { id: number; label: string; mcs: Vec3 }[]): string {
  const chain = measureChain(points.map((p) => p.mcs));
  const rows = points.map((p, i) => {
    const delta = chain[i]!.delta;
    // The first point has no offsets: three empty columns.
    return `${p.id};${p.label};${formatPointCopy(p.mcs)};${delta ? formatPointCopy(delta) : ";;"}`;
  });
  return ["#;label;x;y;z;dx;dy;dz", ...rows].join("\n");
}

/**
 * Component states at `renderTime`: discrete data (register entries, states) from the snapshot at or
 * before `renderTime`, continuous values interpolated towards the next one. Outside the buffered
 * range the nearest snapshot is held; nothing is extrapolated.
 */
function sampleStates(
  snapshots: readonly StateMessage[],
  renderTime: number,
  configs: ReadonlyMap<number, ComponentConfig>,
): Map<number, ComponentState> {
  let before: StateMessage | undefined;
  let after: StateMessage | undefined;
  for (const s of snapshots) {
    if (s.tRel <= renderTime) {
      if (!before || s.tRel > before.tRel) before = s;
    } else if (!after || s.tRel < after.tRel) {
      after = s;
    }
  }
  const base = before ?? after;
  const result = new Map<number, ComponentState>();
  if (!base) return result;
  const next = before && after ? new Map(after.components.map((c) => [c.id, c])) : undefined;
  const f = before && after ? (renderTime - before.tRel) / (after.tRel - before.tRel) : 0;
  for (const c of base.components) {
    const n = next?.get(c.id);
    const config = configs.get(c.id);
    const interpolate = kitOf(c.type).interpolate;
    result.set(c.id, n && n.type === c.type && config?.type === c.type && interpolate ? interpolate(c, n, f, config) : c);
  }
  return result;
}
