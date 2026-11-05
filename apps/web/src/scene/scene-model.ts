import {
  deltaForward,
  type Body,
  type BodyRole,
  type BodyShape,
  type BodyState,
  deltaInverse,
  type CartesianConfig,
  type CartesianState,
  type ComponentState,
  type ConfigMessage,
  type ConveyorConfig,
  type ConveyorState,
  type DeltaConfig,
  type DeltaState,
  type Fault,
  type Finger,
  type FingerState,
  type ComponentConfig,
  type Pose,
  type Position,
  type Product,
  type ProductShape,
  type ProductState,
  type ProductType,
  type StateMessage,
  type TrackModule,
  type TrackModuleState,
  alongModule,
  curveCentre,
  moduleStarts,
  moduleTurn,
  curveRadius,
  trackLength,
  trackPoint,
  type XtsGantryConfig,
  type XtsGantryState,
  type XtsLoopConfig,
  type XtsLoopState,
  type Zone,
} from "@rpp/protocol";
import {
  apply,
  child,
  mul,
  frameFromPose,
  fromRenderer,
  rotX,
  rotZ,
  toLocal,
  toMcs,
  toRenderer,
  toRendererTransform,
  type Frame,
  type Mat3,
  type Transform,
  type Vec3,
} from "./frames";

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

export type CartesianPartKey = "rail left" | "rail right" | "bridge" | "carriage" | "column";

export interface SceneCartesian {
  id: number;
  name: string;
  /** Rails (static), bridge, carriage and column (moving with the axes). */
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
}

/** Active faults of one component (its own first, then its movers' and track modules'), for the component list. */
export interface ComponentFaults {
  componentId: number;
  messages: string[];
}

export interface SceneModel {
  conveyors: SceneConveyor[];
  products: SceneProduct[];
  deltas: SceneDelta[];
  workingAreas: SceneWorkingArea[];
  zones: SceneZone[];
  gantries: SceneGantry[];
  boxAreas: SceneBoxArea[];
  /** Delta limit areas: boxes in the robot frame that further restrict the working area. */
  limitAreas: SceneBoxArea[];
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

const MM = 1 / 1000;

/** One gripper of a robot (one per mover for XTS kinematics): where its fingers hang and whether it is faulted. */
type GripperSource = { moverId: number; flange: Frame; states: FingerState[]; faulted: boolean };

/** How far above its anchor a fault label hangs, mm. */
const LABEL_LIFT = {
  conveyor: 150,
  delta: 250,
  track: 300,
  gantryMover: 200,
  loopMover: 150,
  module: 150,
  cartesian: 200,
  body: 150,
};

/** The message to show for a fault; the PLC may leave it empty. */
export function faultText(fault: Fault | null | undefined): string | null {
  return fault ? fault.message || "Fault" : null;
}

/** An MCS point lifted by the given height along MCS Z. */
function lifted(p: Vec3, height: number): Vec3 {
  return [p[0], p[1], p[2] + height];
}
const DEFAULT_PRODUCT: ProductType = { id: 0, length: 100, width: 100, height: 100, shape: "box", cornerRadius: 0 };

/** An XTS component as recordings made before protocol 12 hold it, without track modules: drawn without a track. */
function withModules<T extends { modules: TrackModule[] }>(c: T): T {
  return c.modules ? c : { ...c, modules: [] };
}

/** A product type as recordings made before protocol 10 hold it, without a shape, is a box. */
function withShape(type: ProductType): ProductType {
  return { ...type, shape: type.shape ?? "box", cornerRadius: type.cornerRadius ?? 0 };
}

type ComponentType = ComponentConfig["type"];
type ConfigOf<T extends ComponentType> = Extract<ComponentConfig, { type: T }>;
type StateOf<T extends ComponentType> = Extract<ComponentState, { type: T }>;

/** What a component's kit adds its part of the scene through. */
interface BuildContext {
  /** The scene so far, hidden components included; they are dropped at the end. */
  scene: SceneModel;
  /**
   * Where a picked product hangs, keyed "robotId:moverId" for the gripper flange (mover 0 for a robot without movers)
   * and "robotId:moverId:finger" for a finger's grip point: an MCS frame whose origin touches the product's top, whose
   * rotation orients the product and whose local −Z points to the product.
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
  warn(message: string): void;
  /** Whether products get snap points: only measure mode needs them, and they are many. */
  productSnapPoints: boolean;
}

/** How a scene is built beyond its data. */
export interface SceneOptions {
  /**
   * Snap points on every product (bottom centre, corners or outline), for measure mode; default true. Thousands of
   * products give tens of thousands of points, so the 3D view asks for them only while measuring.
   */
  productSnapPoints?: boolean;
}

/** How one component type becomes part of the scene. */
interface ComponentKit<T extends ComponentType> {
  build(c: ConfigOf<T>, state: StateOf<T> | undefined, ctx: BuildContext): void;
  /** The state between two snapshots (`f` from 0 to 1); without it, the earlier snapshot is held. */
  interpolate?(a: StateOf<T>, b: StateOf<T>, f: number, c: ConfigOf<T>): StateOf<T>;
  /** Built after all others, e.g. a conveyor whose products hang from the carriers the robots provide. */
  late?: boolean;
  /** Order of its origin in measure mode, lower first; default 2. */
  originRank?: number;
}

/**
 * Every component type the scene knows. A new component type needs one entry here and, in `SceneView.tsx`, a mesh
 * for what it adds to the scene.
 */
const KITS: { [T in ComponentType]: ComponentKit<T> } = {
  conveyor: {
    late: true,
    originRank: 0,
    build(c, state, ctx) {
      const frame = frameFromPose(c.pose);
      const fault = faultText(state?.fault);
      ctx.scene.conveyors.push({
        id: c.id,
        name: c.name,
        transform: toRendererTransform(frame),
        length: c.length * MM,
        width: c.width * MM,
        fault,
      });
      ctx.addFault(c.id, null, fault, lifted(toMcs(frame, [c.length / 2, 0, 0]), LABEL_LIFT.conveyor));
      const owner = snapOwner(c, frame);
      const snapPoints = ctx.scene.snapPoints;
      snapPoints.push(owner.at(`${c.name} · origin`, shiftOf(c)));
      for (const end of ["start", "end"] as const) {
        for (const [side, y] of sides(c.width)) {
          snapPoints.push(owner.at(`${c.name} · ${end}, ${side}`, [end === "start" ? 0 : c.length, y, 0]));
        }
      }
      snapPoints.push(owner.at(`${c.name} · end centre`, [c.length, 0, 0]));
      if (state) {
        const shown = conveyorProducts(c, frame, state, ctx.carriers, ctx.warn);
        ctx.scene.products.push(...shown);
        if (ctx.productSnapPoints) for (const p of shown) snapPoints.push(...productSnapPoints(p, owner));
      }
    },
    interpolate: (a, b, f) => ({ ...a, beltPosition: lerp(a.beltPosition, b.beltPosition, f) }),
  },
  delta: {
    originRank: 1,
    build(c, state, ctx) {
      const frame = frameFromPose(c.pose);
      const delta = buildDelta(c, state);
      ctx.scene.deltas.push(delta);
      ctx.addFault(c.id, null, delta.fault, lifted(frame.origin, LABEL_LIFT.delta));
      if (state) {
        // The flange frame lies at the TCP with the MCS axes, whatever way the robot is mounted.
        const flange: Frame = { rotation: rotZ(0), origin: positionToMcs(state.actualTcp) };
        ctx.carriers.set(`${c.id}:0`, flange);
        ctx.addGripper(c, [{ moverId: 0, flange, states: state.fingers, faulted: delta.fault !== null }]);
      }
      ctx.scene.snapPoints.push(...deltaSnapPoints(c, state));
      const w = c.workingArea;
      ctx.scene.workingAreas.push({
        robotId: c.id,
        transform: toRendererTransform(frame),
        radius: w.radius * MM,
        zMin: w.zMin * MM,
        zMax: w.zMax * MM,
        coneHeight: w.coneHeight * MM,
        coneBottomRadius: w.coneBottomRadius * MM,
      });
      if (c.limitArea) {
        const a = c.limitArea;
        ctx.scene.limitAreas.push({
          robotId: c.id,
          transform: toRendererTransform(
            child(frame, [(a.xMin + a.xMax) / 2, (a.yMin + a.yMax) / 2, (a.zMin + a.zMax) / 2]),
          ),
          size: [(a.xMax - a.xMin) * MM, (a.yMax - a.yMin) * MM, (a.zMax - a.zMin) * MM],
        });
      }
      ctx.addZones(c);
    },
    interpolate: (a, b, f) => ({
      ...a,
      actualTcp: lerpPosition(a.actualTcp, b.actualTcp, f),
      setpointTcp: lerpPosition(a.setpointTcp, b.setpointTcp, f),
      fingers: lerpFingers(a.fingers, b.fingers, f),
    }),
  },
  xtsGantry: {
    build(c, state, ctx) {
      const built = buildGantry(withModules(c), state);
      ctx.scene.gantries.push(built.gantry);
      ctx.scene.boxAreas.push(built.area);
      ctx.scene.snapPoints.push(...built.snapPoints);
      for (const [moverId, frame] of built.carriers) ctx.carriers.set(`${c.id}:${moverId}`, frame);
      for (const f of built.faults) ctx.addFault(c.id, f.part, f.message, f.anchor);
      ctx.addGripper(c, built.grippers);
      ctx.addZones(c);
    },
    interpolate(a, b, f) {
      const next = new Map(b.movers.map((m) => [m.id, m]));
      return {
        ...a,
        z: lerp(a.z, b.z, f),
        movers: a.movers.map((m) => {
          const n = next.get(m.id);
          return n
            ? { ...m, position: lerp(m.position, n.position, f), x: lerp(m.x, n.x, f), fingers: lerpFingers(m.fingers, n.fingers, f) }
            : m;
        }),
      };
    },
  },
  xtsLoop: {
    build(c, state, ctx) {
      const built = buildLoop(withModules(c), state, ctx.warn);
      ctx.scene.loops.push(built.loop);
      ctx.scene.snapPoints.push(...built.snapPoints);
      for (const [moverId, frame] of built.carriers) ctx.carriers.set(`${c.id}:${moverId}`, frame);
      for (const f of built.faults) ctx.addFault(c.id, f.part, f.message, f.anchor);
      ctx.addGripper(c, built.grippers);
      ctx.addZones(c);
    },
    interpolate(a, b, f, c) {
      const perimeter = trackLength(withModules(c).modules);
      const next = new Map(b.movers.map((m) => [m.id, m]));
      return {
        ...a,
        movers: a.movers.map((m) => {
          const n = next.get(m.id);
          return n
            ? { ...m, position: lerpWrapped(m.position, n.position, f, perimeter), fingers: lerpFingers(m.fingers, n.fingers, f) }
            : m;
        }),
      };
    },
  },
  cartesian: {
    build(c, state, ctx) {
      const built = buildCartesian(c, state);
      ctx.scene.cartesians.push(built.cartesian);
      ctx.scene.boxAreas.push(built.area);
      ctx.scene.snapPoints.push(...built.snapPoints);
      if (built.carrier) ctx.carriers.set(`${c.id}:0`, built.carrier);
      ctx.addFault(c.id, null, built.cartesian.fault, built.faultAnchor);
      ctx.addGripper(c, built.grippers);
      ctx.addZones(c);
    },
    interpolate: (a, b, f) => ({
      ...a,
      x: lerp(a.x, b.x, f),
      y: lerp(a.y, b.y, f),
      z: lerp(a.z, b.z, f),
      fingers: lerpFingers(a.fingers, b.fingers, f),
    }),
  },
  vision: bodyKit(),
  sensor: bodyKit(),
  station: bodyKit(),
};

/** Component types drawn only from the bodies they describe. */
type BodyComponentType = "vision" | "sensor" | "station";

/** Roles drawn as overlays: on the zones layer, also for their snap points. */
const OVERLAY_ROLES: ReadonlySet<BodyRole> = new Set(["beam", "fieldOfView"]);

/** "fieldOfView" → "field of view". */
const roleText = (role: BodyRole) => role.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/**
 * A component drawn only from the bodies, zones and fault it reports, e.g. a vision system, a product sensor or a
 * station: the scene needs to know nothing else about it.
 */
function bodyKit<T extends BodyComponentType>(): ComponentKit<T> {
  return { build: buildFromBodies };
}

function buildFromBodies(
  c: ConfigOf<BodyComponentType>,
  state: StateOf<BodyComponentType> | undefined,
  ctx: BuildContext,
): void {
  const frame = frameFromPose(c.pose);
  const fault = faultText(state?.fault);
  const owner = snapOwner(c, frame);
  ctx.scene.snapPoints.push(owner.at(`${c.name} · origin`, shiftOf(c)));
  let top: Vec3 = frame.origin;
  c.bodies.forEach((b: Body, i) => {
    const bottom = child(frame, [b.pose.x, b.pose.y, b.pose.z], frameFromPose({ ...b.pose, x: 0, y: 0, z: 0 }).rotation);
    const bodyState: BodyState | undefined = state?.bodies[i];
    ctx.scene.bodies.push({
      key: `${c.id}:${i}`,
      componentId: c.id,
      shape: b.shape,
      role: b.role,
      transform: toRendererTransform(bottom),
      size: { length: b.length * MM, width: b.width * MM, height: b.height * MM },
      top: { length: b.topLength * MM, width: b.topWidth * MM },
      active: bodyState?.active ?? false,
      faulted: fault !== null,
    });
    const layer = OVERLAY_ROLES.has(b.role) ? "zones" : "structure";
    ctx.scene.snapPoints.push(owner.atMcs(`${c.name} · body ${i + 1} (${roleText(b.role)})`, bottom.origin, layer));
    const bodyTop = toMcs(bottom, [0, 0, b.height]);
    if (bodyTop[2] > top[2]) top = bodyTop;
  });
  ctx.addFault(c.id, null, fault, lifted(top, LABEL_LIFT.body));
  ctx.addZones(c);
}

/** The kit of a component type, typed for the whole union: each kit only ever gets configs and states of its type. */
const kitOf = (type: ComponentType) => KITS[type] as unknown as ComponentKit<ComponentType>;

/** A scene with nothing in it. */
export function emptyScene(): SceneModel {
  return {
    conveyors: [],
    products: [],
    deltas: [],
    workingAreas: [],
    zones: [],
    gantries: [],
    boxAreas: [],
    limitAreas: [],
    loops: [],
    cartesians: [],
    bodies: [],
    fingers: [],
    snapPoints: [],
    origins: [],
    faultLabels: [],
    faults: [],
    warnings: [],
  };
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

  const ctx: BuildContext = {
    scene,
    productSnapPoints: options.productSnapPoints ?? true,
    carriers: new Map(),
    warn: (message) => warnings.push(message),
    addFault(componentId, part, message, anchor) {
      if (message === null) return;
      faultLabels.push({ key: `${componentId}:${part ?? ""}`, componentId, part, message, position: toRenderer(anchor) });
      let entry = faults.find((f) => f.componentId === componentId);
      if (!entry) faults.push((entry = { componentId, messages: [] }));
      entry.messages.push(part ? `${part}: ${message}` : message);
    },
    addGripper(robot, grippers) {
      const owner = snapOwner(robot, frameFromPose(robot.pose));
      for (const g of grippers) {
        robot.fingers.forEach((f, i) => {
          const state = g.states[i];
          if (!state) return;
          const index = i + 1;
          const frame = frameFromPose(state.pose);
          const grip = child(frame, [0, 0, -f.height]);
          ctx.carriers.set(`${robot.id}:${g.moverId}:${index}`, grip);
          scene.fingers.push({
            key: `${robot.id}:${g.moverId}:${index}`,
            robotId: robot.id,
            moverId: g.moverId,
            index,
            transform: toRendererTransform(frame),
            diameter: f.diameter * MM,
            height: f.height * MM,
            active: state.active,
            faulted: g.faulted,
            flange: toRenderer(g.flange.origin),
          });
          const name = g.moverId ? `${robot.name} · mover ${g.moverId} finger ${index}` : `${robot.name} · finger ${index}`;
          snapPoints.push(owner.atMcs(`${name} grip point`, grip.origin, "structure", true));
        });
      }
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
        if (win.ccsOffset < Math.min(win.start, win.end) || win.ccsOffset > Math.max(win.start, win.end)) {
          warnings.push(
            `${c.name}: CCS of the zone on ${belt.name} (${win.ccsOffset} mm) lies outside the zone (${win.start} to ${win.end} mm)`,
          );
        }
        zones.push({
          componentId: c.id,
          conveyorId: belt.id,
          transform: toRendererTransform(child(beltFrame, [along(zoneCentre), 0, 0])),
          length: Math.abs(win.end - win.start) * MM,
          width: belt.width * MM,
          ccs: toRendererTransform(child(beltFrame, [along(win.ccsOffset), 0, 0])),
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
        for (const [side, y] of sides(belt.width)) {
          snapPoints.push(owner.at(`${name} · start, ${side}`, [along(win.start), y, 0], "zones"));
          snapPoints.push(owner.at(`${name} · end, ${side}`, [along(win.end), y, 0], "zones"));
          if (limit !== undefined) {
            snapPoints.push(owner.at(`${name} · allocation limit, ${side}`, [along(limit), y, 0], "zones"));
          }
        }
        snapPoints.push(owner.at(`${name} · CCS`, [along(win.ccsOffset), 0, 0], "zones"));
      }
    },
  };

  // Components that draw products come last: the products hang from the carriers the others provide.
  const late = (c: ComponentConfig) => kitOf(c.type).late === true;
  for (const c of [...components.filter((c) => !late(c)), ...components.filter(late)]) {
    const state = states.get(c.id);
    kitOf(c.type).build(c, state?.type === c.type ? state : undefined, ctx);
  }
  // Each component's coordinate system: at its pose, moved by its origin shift.
  const rank = (c: ComponentConfig) => kitOf(c.type).originRank ?? 2;
  const origins = [...components]
    .sort((a, b) => rank(a) - rank(b))
    .map((c) => ({ componentId: c.id, name: c.name, transform: toRendererTransform(originFrame(c)) }));
  // Hidden components are built too (a hidden robot still carries products of a visible conveyor), then dropped.
  const shown = (id: number) => !hidden.has(id);
  return {
    conveyors: scene.conveyors.filter((c) => shown(c.id)),
    products: scene.products.filter((p) => shown(p.conveyorId)),
    deltas: scene.deltas.filter((d) => shown(d.id)),
    workingAreas: scene.workingAreas.filter((a) => shown(a.robotId)),
    zones,
    gantries: scene.gantries.filter((g) => shown(g.id)),
    boxAreas: scene.boxAreas.filter((a) => shown(a.robotId)),
    limitAreas: scene.limitAreas.filter((a) => shown(a.robotId)),
    loops: scene.loops.filter((l) => shown(l.id)),
    cartesians: scene.cartesians.filter((c) => shown(c.id)),
    bodies: scene.bodies.filter((b) => shown(b.componentId)),
    fingers: scene.fingers.filter((f) => shown(f.robotId)),
    snapPoints: snapPoints.filter((p) => shown(p.local.componentId)),
    origins: origins.filter((o) => shown(o.componentId)),
    faultLabels: faultLabels.filter((l) => shown(l.componentId)),
    faults,
    warnings,
  };
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
    return { sourceId, online, scene: buildScene(config, snapshots, renderTime, hiddenIds, options) };
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

/** Left (local +Y) and right edge of a belt of the given width. */
function sides(width: number): [string, number][] {
  return [
    ["left", width / 2],
    ["right", -width / 2],
  ];
}

type SnapOwner = ReturnType<typeof snapOwner>;

/** A component's origin shift as a vector in its local frame. */
function shiftOf(c: { originShift: Position }): Vec3 {
  return [c.originShift.x, c.originShift.y, c.originShift.z];
}

/** The frame of a component's coordinate system: its pose moved by its origin shift (no rotation). */
function originFrame(c: { pose: Pose; originShift: Position }): Frame {
  return child(frameFromPose(c.pose), shiftOf(c));
}

/**
 * Creates the snap points of one component. Points are given in the frame of its pose (`frame`); their local
 * measuring coordinates are in its coordinate system, i.e. from its shifted origin.
 */
function snapOwner(component: { id: number; name: string; originShift: Position }, frame: Frame) {
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

/** Base, shoulders, working area and actual TCP of a Delta, in its base frame. */
function deltaSnapPoints(c: DeltaConfig, state: DeltaState | undefined): SnapPoint[] {
  const owner = snapOwner(c, frameFromPose(c.pose));
  // The shoulders do not depend on the arm angles.
  const { shoulders } = deltaForward(c, [0, 0, 0]);
  const w = c.workingArea;
  const points = [
    owner.at(`${c.name} · base`, [0, 0, 0]),
    ...shoulders.map((s, i) => owner.at(`${c.name} · shoulder ${i + 1}`, s)),
    owner.at(`${c.name} working area · top`, [0, 0, w.zMax], "workingAreas"),
    owner.at(`${c.name} working area · bottom`, [0, 0, w.zMin], "workingAreas"),
  ];
  if (w.coneHeight > 0) {
    points.push(owner.at(`${c.name} working area · cone bottom`, [0, 0, w.zMin - w.coneHeight], "workingAreas"));
  }
  const a = c.limitArea;
  if (a) {
    for (const [zName, zc] of [["bottom", a.zMin], ["top", a.zMax]] as const) {
      for (const [yName, yc] of [["Y min", a.yMin], ["Y max", a.yMax]] as const) {
        for (const [xName, xc] of [["X min", a.xMin], ["X max", a.xMax]] as const) {
          points.push(owner.at(`${c.name} limit area · ${zName}, ${yName}, ${xName}`, [xc, yc, zc], "limitAreas"));
        }
      }
    }
  }
  if (state) points.push(owner.atMcs(`${c.name} · TCP`, positionToMcs(state.actualTcp), "structure", true));
  return points;
}

/**
 * Points on the bottom of a drawn product (not of a placeholder), in belt coordinates: its bottom centre, and the
 * corners of a box; a cylinder or rounded box has no corners, so its outline's front, back, left and right instead.
 */
function productSnapPoints(p: SceneProduct, owner: SnapOwner): SnapPoint[] {
  if (p.display === "placeholder") return [];
  const length = p.size.length / MM;
  const width = p.size.width / MM;
  const bottom = p.bottom;
  const name = `Product #${p.productId}`;
  const point = (label: string, x: number, y: number) =>
    owner.atMcs(`${name} · ${label}`, toMcs(bottom, [x, y, 0]), "structure", true);
  const outline =
    p.shape === "box"
      ? [
          point("front left", length / 2, width / 2),
          point("front right", length / 2, -width / 2),
          point("back left", -length / 2, width / 2),
          point("back right", -length / 2, -width / 2),
        ]
      : [
          point("front", length / 2, 0),
          point("back", -length / 2, 0),
          point("left", 0, width / 2),
          point("right", 0, -width / 2),
        ];
  return [...outline, point("bottom centre", 0, 0)];
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

function positionToMcs(p: Position): Vec3 {
  return [p.x, p.y, p.z];
}

/**
 * The PLC reports only the TCP (effector centre); the arms follow it by inverse kinematics in the robot frame.
 * Before the first state the robot is drawn with horizontal upper arms.
 */
function buildDelta(c: DeltaConfig, state: DeltaState | undefined): SceneDelta {
  const frame = frameFromPose(c.pose);
  const world = (local: Vec3) => toRenderer(toMcs(frame, local));
  const localTcp = state ? toLocal(frame, positionToMcs(state.actualTcp)) : undefined;
  const angles = localTcp ? deltaInverse(c, localTcp) : [0, 0, 0];
  const posture = deltaForward(c, (angles ?? [0, 0, 0]) as [number, number, number]);
  const effectorCentre = localTcp ?? posture.effector;
  return {
    id: c.id,
    name: c.name,
    base: toRendererTransform(frame),
    baseRadius: c.baseRadius * MM,
    effectorRadius: c.effectorRadius * MM,
    shoulders: posture.shoulders.map(world),
    elbows: angles ? posture.elbows.map(world) : [],
    effectorJoints: angles ? posture.effectorJoints.map(world) : [],
    effector: effectorCentre ? toRendererTransform(child(frame, effectorCentre)) : null,
    reachable: angles !== null,
    actualTcp: state ? toRenderer(positionToMcs(state.actualTcp)) : null,
    setpointTcp: state ? toRenderer(positionToMcs(state.setpointTcp)) : null,
    angles: angles ?? [],
    fault: faultText(state?.fault),
  };
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

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** Interpolate degrees along the shorter way, so 179° → −179° passes through 180°, not 0°. */
function lerpAngle(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * f;
}

/** Interpolate a position on a closed track of the given perimeter along the shorter way. */
function lerpWrapped(a: number, b: number, f: number, perimeter: number): number {
  if (perimeter <= 0) return lerp(a, b, f);
  const d = ((((b - a) % perimeter) + 1.5 * perimeter) % perimeter) - 0.5 * perimeter;
  return a + d * f;
}


function lerpPosition(a: Position, b: Position, f: number): Position {
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
function lerpFingers(a: FingerState[], b: FingerState[], f: number): FingerState[] {
  return a.map((s, i) => {
    const n = b[i];
    return n ? { ...s, pose: lerpPose(s.pose, n.pose, f) } : s;
  });
}

/** How far along the belt a product is now, mm from the conveyor's pose along its conveying direction. */
export function productBeltX(c: ConveyorConfig, state: ConveyorState, p: Product): number {
  // The latch pose is in the conveyor's coordinate system, which lies at the origin shift from its pose.
  return c.originShift.x + p.latchPose.x + (state.beltPosition - p.latchBeltPosition);
}

/** A product's bottom centre now, in the MCS and turned with the product: its latch pose moved by the belt travel. */
function productBottom(c: ConveyorConfig, state: ConveyorState, p: Product): Frame {
  const belt = originFrame(c);
  const travel = state.beltPosition - p.latchBeltPosition;
  return child(belt, [p.latchPose.x + travel, p.latchPose.y, p.latchPose.z], rotZ(p.latchPose.rz));
}

/**
 * A product that has passed the belt end without being picked or placed. Rejected products pass the end on purpose
 * and are not missed.
 */
export function isMissed(c: ConveyorConfig, state: ConveyorState, p: Product): boolean {
  return p.state !== "picked" && p.state !== "placed" && p.state !== "rejected" && productBeltX(c, state, p) > c.length;
}

/**
 * Products of one conveyor register, positioned by latch + belt travel, with the display lifecycle:
 * - picked: a placeholder keeps travelling on the belt (until the belt end) while the product itself hangs below
 *   its carrier (robot TCP, mover or finger);
 * - placed: the product was put down onto this belt and lies on it like a detected one, but is never missed.
 */
function conveyorProducts(
  c: ConveyorConfig,
  frame: Frame,
  state: ConveyorState,
  carriers: ReadonlyMap<string, Frame>,
  warn: (message: string) => void,
): SceneProduct[] {
  const direction = apply(frame.rotation, [1, 0, 0]);
  const result: SceneProduct[] = [];
  for (const p of state.products) {
    const type = withShape(c.productTypes.find((t) => t.id === p.productType) ?? DEFAULT_PRODUCT);
    const size = { length: type.length * MM, width: type.width * MM, height: type.height * MM };
    const { rotation, origin } = productBottom(c, state, p);
    const bottom: Vec3 = [...origin];
    const shown = (display: ProductDisplay, frame: Frame): SceneProduct => ({
      key: `${c.id}:${p.id}:${display}`,
      productId: p.id,
      conveyorId: c.id,
      display,
      state: p.state,
      transform: toRendererTransform({ rotation: frame.rotation, origin: toMcs(frame, [0, 0, type.height / 2]) }),
      bottom: frame,
      size,
      shape: type.shape,
      cornerRadius: type.cornerRadius * MM,
      raw: p,
    });
    const onBelt = (display: ProductDisplay) =>
      shown(display, { rotation, origin: [bottom[0], bottom[1], bottom[2]] });

    const beltX = productBeltX(c, state, p);
    const beyondEnd = beltX > c.length;

    if (p.state === "picked") {
      if (!beyondEnd) result.push(onBelt("placeholder"));
      const flange = carriers.get(`${p.lastClientId}:${p.moverId}`);
      let carrier = p.fingerId > 0 ? carriers.get(`${p.lastClientId}:${p.moverId}:${p.fingerId}`) : flange;
      if (!carrier && flange) {
        // An unknown finger: hang it at the flange so it stays visible.
        warn(`${c.name}: product #${p.id} hangs from finger ${p.fingerId}, which robot #${p.lastClientId} does not have`);
        carrier = flange;
      }
      if (carrier) {
        // Hanging from the carrier: the product's top touches the carrier origin.
        result.push(shown("atTcp", { rotation: carrier.rotation, origin: toMcs(carrier, [0, 0, -type.height]) }));
      }
      continue;
    }
    if (!beyondEnd) {
      result.push(onBelt("normal"));
    } else if (isMissed(c, state, p)) {
      // Unpicked past the end: hold it at the belt end, flagged, until the PLC drops the entry.
      const back = beltX - (c.length - type.length / 2);
      bottom[0] -= direction[0] * back;
      bottom[1] -= direction[1] * back;
      bottom[2] -= direction[2] * back;
      result.push(onBelt("missed"));
    }
  }
  return result;
}

/**
 * The plane an XTS track lies in, as a rotation in its component's frame taking the track's u (where the first module
 * starts to run), v (to its left) and normal onto local axes. A gantry's track runs along +Y in the X-Y plane, so v is
 * −X; a loop's along +X in the X-Z plane, so v is +Z (curves to the left turn up).
 */
const TRACK_PLANE = { xtsGantry: rotZ(90), xtsLoop: rotX(90) };

/** Cross-section of a track's modules in the module frame (across, along the normal), mm. */
type TrackSection = { across: [number, number]; depth: [number, number] };

/**
 * An XTS track laid out from its modules inside its track group (`group`: an MCS frame, e.g. a gantry lifted by Z):
 * the modules to draw, the frame at any track position (relative to the group: +X the tangent, +Y left, +Z the plane
 * normal), the module boundaries and curve centres as snap points and the top centre for the fault label.
 */
function layTrack(
  c: { name: string; modules: TrackModule[] },
  states: readonly TrackModuleState[],
  plane: Mat3,
  group: Frame,
  closed: boolean,
  section: TrackSection,
) {
  const starts = moduleStarts(c.modules);
  const absolute = (u: number, v: number) => toMcs(group, apply(plane, [u, v, 0]));
  const faults: { part: string; message: string | null; anchor: Vec3 }[] = [];
  const inPlane = (u: number, v: number, heading: number): Frame => ({
    rotation: mul(plane, rotZ(heading)),
    origin: apply(plane, [u, v, 0]),
  });
  const modules = c.modules.map((m, i): SceneTrackModule => {
    const p = starts[i]!;
    const fault = faultText(states[i]?.fault);
    const middle = alongModule(p, m, m.length / 2);
    faults.push({ part: `Module ${i + 1}`, message: fault, anchor: lifted(absolute(middle.u, middle.v), LABEL_LIFT.module) });
    return {
      key: String(i + 1),
      index: i + 1,
      transform: toRendererTransform(inPlane(p.u, p.v, p.heading)),
      length: m.length * MM,
      radius: moduleTurn(m) === 0 ? 0 : curveRadius(m) * MM,
      turn: moduleTurn(m),
      across: [section.across[0] * MM, section.across[1] * MM],
      depth: [section.depth[0] * MM, section.depth[1] * MM],
      fault,
    };
  });
  const n = c.modules.length;
  const boundaries: { label: string; mcs: Vec3 }[] = [];
  starts.forEach((p, i) => {
    if (closed && n > 0 && i === n) return;
    const label = i === 0 ? "track start" : i === n ? "track end" : `module ${i} / ${i + 1}`;
    boundaries.push({ label: `${c.name} · ${label}`, mcs: absolute(p.u, p.v) });
  });
  c.modules.forEach((m, i) => {
    const centre = curveCentre(starts[i]!, m);
    if (centre) boundaries.push({ label: `${c.name} · module ${i + 1} curve centre`, mcs: absolute(centre.u, centre.v) });
  });
  const end = starts[n]!;
  // Middle and top of the module boundaries, relative to the group.
  const local = starts.map((p) => apply(plane, [p.u, p.v, 0]));
  const span = (k: number) => [Math.min(...local.map((p) => p[k]!)), Math.max(...local.map((p) => p[k]!))] as const;
  const [x, y, z] = [span(0), span(1), span(2)];
  const middle: Vec3 = [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2];
  return {
    modules,
    /** Fault labels of the modules, for the build context. */
    faults,
    boundaries,
    /** How far the end of a closed track lies from its start, mm. */
    gap: closed && n > 0 ? Math.hypot(end.u, end.v) : 0,
    middle,
    /** MCS point above the middle of the track, at its highest module boundary. */
    top: toMcs(group, [middle[0], middle[1], z[1]]),
    /** The frame at a track position, relative to the group. */
    at(position: number): Frame {
      const p = trackPoint(c.modules, position, closed);
      return inPlane(p.u, p.v, p.heading);
    },
  };
}

/** Mover frames of an XTS gantry, its track, its reachable volume, snap points and the frames products hang from. */
function buildGantry(c: XtsGantryConfig, state: XtsGantryState | undefined) {
  const frame = frameFromPose(c.pose);
  const z = state?.z ?? 0;
  const length = trackLength(c.modules);
  const group = child(frame, [0, 0, z]);
  // The beam above the movers: as wide as a mover plus 20 mm each side, 120 mm high.
  const half = (c.moverWidth + 40) / 2;
  // Recordings made before protocol 12 have no module states.
  const track = layTrack(c, state?.modules ?? [], TRACK_PLANE.xtsGantry, group, false, {
    across: [-half, half],
    depth: [0, 120],
  });
  const owner = snapOwner(c, frame);
  const carriers = new Map<number, Frame>();
  const grippers: GripperSource[] = [];
  const gantryFault = faultText(state?.fault);
  const faults: { part: string | null; message: string | null; anchor: Vec3 }[] = [
    { part: null, message: gantryFault, anchor: lifted(track.top, LABEL_LIFT.track) },
  ];
  const snapPoints: SnapPoint[] = track.boundaries.map((b) => owner.atMcs(b.label, b.mcs, "structure", true));
  const movers = (state?.movers ?? []).map((m): SceneGantryMover => {
    // Mover frame: +X its X axis (to the right of the track), +Y along the track, +Z up.
    const at = track.at(m.position);
    const mover = child(group, at.origin, mul(at.rotation, rotZ(-90)));
    const toolX = m.x + c.toolOffsetX;
    const tip = child(mover, [toolX, 0, c.toolOffsetZ]);
    carriers.set(m.id, tip);
    const fault = faultText(m.fault);
    faults.push({ part: `Mover ${m.id}`, message: fault, anchor: lifted(mover.origin, LABEL_LIFT.gantryMover) });
    grippers.push({ moverId: m.id, flange: tip, states: m.fingers, faulted: gantryFault !== null || fault !== null });
    snapPoints.push(owner.atMcs(`${c.name} · mover ${m.id} flange`, tip.origin, "structure", true));
    return {
      id: m.id,
      carriage: toRenderer(mover.origin),
      armEnd: toRenderer(toMcs(mover, [toolX, 0, 0])),
      tip: toRendererTransform(tip),
      gripperActive: c.fingers.length === 0 && m.gripperActive,
      fault,
    };
  });
  const centre: Vec3 = [(c.xMin + c.xMax) / 2 + c.toolOffsetX, length / 2, (c.zMin + c.zMax) / 2 + c.toolOffsetZ];
  return {
    gantry: {
      id: c.id,
      name: c.name,
      track: toRendererTransform(group),
      modules: track.modules,
      moverLength: c.moverLength * MM,
      moverWidth: c.moverWidth * MM,
      movers,
      fault: gantryFault,
    } satisfies SceneGantry,
    area: {
      robotId: c.id,
      transform: toRendererTransform(child(frame, centre)),
      size: [(c.xMax - c.xMin) * MM, length * MM, (c.zMax - c.zMin) * MM],
    } satisfies SceneBoxArea,
    snapPoints,
    carriers,
    grippers,
    faults: [...faults, ...track.faults],
  };
}

/** Mover frames of an XTS loop, its track, snap points and the frames products hang from. */
function buildLoop(c: XtsLoopConfig, state: XtsLoopState | undefined, warn: (message: string) => void) {
  const frame = frameFromPose(c.pose);
  const owner = snapOwner(c, frame);
  // A band 40 mm thick in the track's plane, as deep as a mover is wide.
  const track = layTrack(c, state?.modules ?? [], TRACK_PLANE.xtsLoop, frame, true, {
    across: [-20, 20],
    depth: [-c.moverWidth / 2, c.moverWidth / 2],
  });
  if (track.gap > 1) warn(`${c.name}: the track modules do not close the loop (${Math.round(track.gap)} mm apart)`);
  const carriers = new Map<number, Frame>();
  const grippers: GripperSource[] = [];
  const loopFault = faultText(state?.fault);
  const faults: { part: string | null; message: string | null; anchor: Vec3 }[] = [
    { part: null, message: loopFault, anchor: lifted(track.top, LABEL_LIFT.track) },
  ];
  const snapPoints: SnapPoint[] = track.boundaries.map((b) => owner.atMcs(b.label, b.mcs));
  const movers = (state?.movers ?? []).map((m): SceneLoopMover => {
    // Mover frame: +X along the tangent, +Z to the left (inside the loop), so its −Z points outwards.
    const at = track.at(m.position);
    const mover = child(frame, at.origin, mul(at.rotation, rotX(-90)));
    const tool = child(mover, [0, 0, -c.toolOffset]);
    carriers.set(m.id, tool);
    const fault = faultText(m.fault);
    faults.push({ part: `Mover ${m.id}`, message: fault, anchor: lifted(mover.origin, LABEL_LIFT.loopMover) });
    grippers.push({ moverId: m.id, flange: tool, states: m.fingers, faulted: loopFault !== null || fault !== null });
    snapPoints.push(owner.atMcs(`${c.name} · mover ${m.id} tool`, tool.origin, "structure", true));
    return { id: m.id, transform: toRendererTransform(mover), tool: toRenderer(tool.origin), fault };
  });
  return {
    loop: {
      id: c.id,
      name: c.name,
      base: toRendererTransform(frame),
      modules: track.modules,
      label: toRenderer(track.middle),
      moverLength: c.moverLength * MM,
      moverWidth: c.moverWidth * MM,
      movers,
      fault: loopFault,
    } satisfies SceneLoop,
    snapPoints,
    carriers,
    grippers,
    faults: [...faults, ...track.faults],
  };
}

/** Fixed part dimensions of a Cartesian robot drawing, mm; everything else follows from the strokes. */
const CARTESIAN = {
  margin: 120,
  rail: 80,
  bridgeWidth: 140,
  bridgeHeight: 100,
  carriage: [220, 220, 160] as Vec3,
  column: 90,
};

/**
 * Cartesian robot: rails along local +Y with their top at railHeight, the bridge on top of them at Y, the carriage
 * on the bridge at X and the column ending at the gripper flange (X, Y, Z).
 */
function buildCartesian(c: CartesianConfig, state: CartesianState | undefined) {
  const frame = frameFromPose(c.pose);
  const owner = snapOwner(c, frame);
  const d = CARTESIAN;
  const axes = state ? { x: state.x, y: state.y, z: state.z } : null;
  const { x, y, z } = axes ?? { x: c.xMin, y: c.yMin, z: c.zMax };
  const railX: [string, number][] = [
    ["left", c.xMin - d.margin],
    ["right", c.xMax + d.margin],
  ];
  const railStart = c.yMin - d.margin - d.bridgeWidth / 2;
  const railEnd = c.yMax + d.margin + d.bridgeWidth / 2;
  const bridgeZ = c.railHeight + d.bridgeHeight / 2;
  const columnLength = c.railHeight + d.bridgeHeight - c.zMin;
  const flange = child(frame, [x, y, z]);
  const box = (key: CartesianPartKey, at: Frame, size: Vec3) => ({
    key,
    transform: toRendererTransform(at),
    size: size.map((v) => v * MM) as Vec3,
  });
  const parts = [
    ...railX.map(([side, rx]) =>
      box(`rail ${side}` as CartesianPartKey, child(frame, [rx, (railStart + railEnd) / 2, c.railHeight - d.rail / 2]), [
        d.rail,
        railEnd - railStart,
        d.rail,
      ]),
    ),
    box("bridge", child(frame, [(c.xMin + c.xMax) / 2, y, bridgeZ]), [
      c.xMax - c.xMin + 2 * d.margin + d.rail,
      d.bridgeWidth,
      d.bridgeHeight,
    ]),
    box("carriage", child(frame, [x, y, bridgeZ]), d.carriage),
    box("column", child(frame, [x, y, z + columnLength / 2]), [d.column, d.column, columnLength]),
  ];

  const snapPoints: SnapPoint[] = [owner.at(`${c.name} · origin`, [0, 0, 0])];
  for (const [side, rx] of railX) {
    snapPoints.push(owner.at(`${c.name} · rail ${side}, start`, [rx, railStart, c.railHeight]));
    snapPoints.push(owner.at(`${c.name} · rail ${side}, end`, [rx, railEnd, c.railHeight]));
  }
  // Reachable flange volume.
  const zLow = c.zMin;
  const zHigh = c.zMax;
  for (const [zName, zc] of [["bottom", zLow], ["top", zHigh]] as const) {
    for (const [yName, yc] of [["start", c.yMin], ["end", c.yMax]] as const) {
      for (const [xName, xc] of [["X min", c.xMin], ["X max", c.xMax]] as const) {
        snapPoints.push(owner.at(`${c.name} stroke space · ${zName}, ${yName}, ${xName}`, [xc, yc, zc], "workingAreas"));
      }
    }
  }
  if (state) snapPoints.push(owner.atMcs(`${c.name} · flange`, flange.origin, "structure", true));
  return {
    cartesian: {
      id: c.id,
      name: c.name,
      parts,
      flange: state ? toRendererTransform(flange) : null,
      gripperActive: c.fingers.length === 0 && (state?.gripperActive ?? false),
      axes,
      fault: faultText(state?.fault),
    } satisfies SceneCartesian,
    area: {
      robotId: c.id,
      transform: toRendererTransform(child(frame, [(c.xMin + c.xMax) / 2, (c.yMin + c.yMax) / 2, (zLow + zHigh) / 2])),
      size: [(c.xMax - c.xMin) * MM, (c.yMax - c.yMin) * MM, (zHigh - zLow) * MM],
    } satisfies SceneBoxArea,
    snapPoints,
    /** A carried product without finger hangs at the flange. */
    carrier: state ? flange : undefined,
    grippers: state ? [{ moverId: 0, flange, states: state.fingers, faulted: state.fault !== null }] : [],
    /** Above the middle of the bridge's travel. */
    faultAnchor: lifted(
      toMcs(frame, [(c.xMin + c.xMax) / 2, (c.yMin + c.yMax) / 2, c.railHeight + d.bridgeHeight]),
      LABEL_LIFT.cartesian,
    ),
  };
}
