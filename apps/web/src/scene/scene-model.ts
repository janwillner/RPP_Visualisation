import {
  deltaForward,
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
  type ProductState,
  type ProductType,
  type StateMessage,
  type XtsGantryConfig,
  type XtsGantryState,
  type XtsLoopConfig,
  type XtsLoopState,
  type Zone,
  type ZoneKind,
} from "@rpp/protocol";
import {
  apply,
  child,
  frameFromPose,
  fromRenderer,
  rotY,
  rotZ,
  toLocal,
  toMcs,
  toRenderer,
  toRendererTransform,
  type Frame,
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
  /** Box centre. Local +X along the product length, local +Y up. */
  transform: Transform;
  /** MCS frame (mm) at the product's bottom centre; local +X along its length, local +Z up through the product. */
  bottom: Frame;
  size: Size;
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
  /** Effector centre at the actual TCP (the gripper flange), turned with the base. */
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
  robotId: number;
  conveyorId: number;
  kind: ZoneKind;
  /** Centre of the zone on the belt surface; extends along local +X. */
  transform: Transform;
  length: number;
  width: number;
  /** The robot's conveyor coordinate system (CCS) on the belt's centre line, oriented like the belt. */
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

export interface SceneGantry {
  id: number;
  name: string;
  /** Track start at the current Z position; the track runs along local MCS +Y (renderer local −Z). */
  track: Transform;
  trackLength: number;
  moduleLength: number;
  moduleCount: number;
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
  /** Start of the lower straight; the loop lies in the local X-Z plane. */
  base: Transform;
  straightLength: number;
  curveRadius: number;
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

/** A fault message drawn above a faulted component or mover. */
export interface SceneFaultLabel {
  key: string;
  componentId: number;
  /** 0 for the component itself. */
  moverId: number;
  message: string;
  /** Renderer frame, metres: where the label hangs. */
  position: Vec3;
}

/** Active faults of one component (its own first, then its movers'), for the component list. */
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
const LABEL_LIFT = { conveyor: 150, delta: 250, track: 300, gantryMover: 200, loopMover: 150, cartesian: 200 };

/** The message to show for a fault; the PLC may leave it empty. */
export function faultText(fault: Fault | null | undefined): string | null {
  return fault ? fault.message || "Fault" : null;
}

/** An MCS point lifted by the given height along MCS Z. */
function lifted(p: Vec3, height: number): Vec3 {
  return [p[0], p[1], p[2] + height];
}
const DEFAULT_PRODUCT: ProductType = { id: 0, length: 100, width: 100, height: 100 };

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
): SceneModel {
  const perimeters = new Map<number, number>();
  for (const c of config?.components ?? []) if (c.type === "xtsLoop") perimeters.set(c.id, loopPerimeter(c));
  const states = sampleStates(snapshots, renderTime, perimeters);
  const conveyors: SceneConveyor[] = [];
  const products: SceneProduct[] = [];
  const deltas: SceneDelta[] = [];
  const gantries: SceneGantry[] = [];
  const boxAreas: SceneBoxArea[] = [];
  const limitAreas: SceneBoxArea[] = [];
  const loops: SceneLoop[] = [];
  const cartesians: SceneCartesian[] = [];
  const fingers: SceneFinger[] = [];
  const faultLabels: SceneFaultLabel[] = [];
  const faults: ComponentFaults[] = [];
  /** A label for a component (moverId 0) or a mover at an MCS anchor, and its line in the component list. */
  const addFault = (componentId: number, moverId: number, message: string | null, anchor: Vec3) => {
    if (message === null) return;
    faultLabels.push({ key: `${componentId}:${moverId}`, componentId, moverId, message, position: toRenderer(anchor) });
    let entry = faults.find((f) => f.componentId === componentId);
    if (!entry) faults.push((entry = { componentId, messages: [] }));
    entry.messages.push(moverId ? `Mover ${moverId}: ${message}` : message);
  };
  /**
   * Where a picked product hangs, keyed "robotId:moverId" for the gripper flange (mover 0 for a robot without movers)
   * and "robotId:moverId:finger" for a finger's grip point: an MCS frame whose origin touches the product's top, whose
   * rotation orients the product and whose local −Z points to the product.
   */
  const carriers = new Map<string, Frame>();

  const workingAreas: SceneWorkingArea[] = [];
  const zones: SceneZone[] = [];
  const warnings: string[] = [];
  const snapPoints: SnapPoint[] = [];
  const conveyorConfigs = new Map<number, ConveyorConfig>();
  for (const c of config?.components ?? []) if (c.type === "conveyor") conveyorConfigs.set(c.id, c);

  /** Fingers of one robot's grippers (one per mover), their grip points as carriers and snap points. */
  const addGripper = (
    robot: { id: number; name: string; pose: Pose; fingers: Finger[]; originShift: Position },
    grippers: GripperSource[],
  ) => {
    const owner = snapOwner(robot, frameFromPose(robot.pose));
    for (const g of grippers) {
      robot.fingers.forEach((f, i) => {
        const state = g.states[i];
        if (!state) return;
        const index = i + 1;
        const frame = frameFromPose(state.pose);
        const grip = child(frame, [0, 0, -f.height]);
        carriers.set(`${robot.id}:${g.moverId}:${index}`, grip);
        fingers.push({
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
  };

  const addZones = (c: { id: number; name: string; zones: Zone[] }) => {
    if (hidden.has(c.id)) return;
    for (const win of c.zones) {
      const belt = conveyorConfigs.get(win.conveyorId);
      if (!belt) {
        warnings.push(`${c.name}: ${win.kind} zone references unknown conveyor ${win.conveyorId}`);
        continue;
      }
      if (hidden.has(belt.id)) continue;
      const beltFrame = frameFromPose(belt.pose);
      // Belt coordinates count from the conveyor's origin, which may be shifted from the belt start.
      const along = (beltCoordinate: number) => belt.originShift.x + beltCoordinate;
      const limit = allocationLimit(win);
      const zoneCentre = (win.start + win.end) / 2;
      const name = `${c.name} ${win.kind} zone on ${belt.name}`;
      if (win.ccsOffset < Math.min(win.start, win.end) || win.ccsOffset > Math.max(win.start, win.end)) {
        warnings.push(
          `${c.name}: CCS of the ${win.kind} zone on ${belt.name} (${win.ccsOffset} mm) lies outside the zone (${win.start} to ${win.end} mm)`,
        );
      }
      zones.push({
        robotId: c.id,
        conveyorId: belt.id,
        kind: win.kind,
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
  };

  for (const c of config?.components ?? []) {
    const state = states.get(c.id);
    if (c.type === "xtsGantry") {
      const built = buildGantry(c, state?.type === "xtsGantry" ? state : undefined);
      gantries.push(built.gantry);
      boxAreas.push(built.area);
      snapPoints.push(...built.snapPoints);
      for (const [moverId, frame] of built.carriers) carriers.set(`${c.id}:${moverId}`, frame);
      for (const f of built.faults) addFault(c.id, f.moverId, f.message, f.anchor);
      addGripper(c, built.grippers);
      addZones(c);
      continue;
    }
    if (c.type === "xtsLoop") {
      const built = buildLoop(c, state?.type === "xtsLoop" ? state : undefined);
      loops.push(built.loop);
      snapPoints.push(...built.snapPoints);
      for (const [moverId, frame] of built.carriers) carriers.set(`${c.id}:${moverId}`, frame);
      for (const f of built.faults) addFault(c.id, f.moverId, f.message, f.anchor);
      addGripper(c, built.grippers);
      addZones(c);
      continue;
    }
    if (c.type === "cartesian") {
      const built = buildCartesian(c, state?.type === "cartesian" ? state : undefined);
      cartesians.push(built.cartesian);
      boxAreas.push(built.area);
      snapPoints.push(...built.snapPoints);
      if (built.carrier) carriers.set(`${c.id}:0`, built.carrier);
      addFault(c.id, 0, built.cartesian.fault, built.faultAnchor);
      addGripper(c, built.grippers);
      addZones(c);
      continue;
    }
    if (c.type !== "delta") continue;
    const deltaState = state?.type === "delta" ? state : undefined;
    const builtDelta = buildDelta(c, deltaState);
    deltas.push(builtDelta);
    addFault(c.id, 0, builtDelta.fault, lifted(frameFromPose(c.pose).origin, LABEL_LIFT.delta));
    if (deltaState) {
      // The flange is the effector centre, turned with the base.
      const flange: Frame = { rotation: frameFromPose(c.pose).rotation, origin: positionToMcs(deltaState.actualTcp) };
      carriers.set(`${c.id}:0`, flange);
      addGripper(c, [{ moverId: 0, flange, states: deltaState.fingers, faulted: builtDelta.fault !== null }]);
    }
    snapPoints.push(...deltaSnapPoints(c, deltaState));

    const w = c.workingArea;
    workingAreas.push({
      robotId: c.id,
      transform: toRendererTransform(frameFromPose(c.pose)),
      radius: w.radius * MM,
      zMin: w.zMin * MM,
      zMax: w.zMax * MM,
      coneHeight: w.coneHeight * MM,
      coneBottomRadius: w.coneBottomRadius * MM,
    });
    if (c.limitArea) {
      const a = c.limitArea;
      limitAreas.push({
        robotId: c.id,
        transform: toRendererTransform(
          child(frameFromPose(c.pose), [(a.xMin + a.xMax) / 2, (a.yMin + a.yMax) / 2, (a.zMin + a.zMax) / 2]),
        ),
        size: [(a.xMax - a.xMin) * MM, (a.yMax - a.yMin) * MM, (a.zMax - a.zMin) * MM],
      });
    }
    addZones(c);
  }

  for (const c of config?.components ?? []) {
    if (c.type !== "conveyor") continue;
    const frame = frameFromPose(c.pose);
    const conveyorState = states.get(c.id);
    const fault = faultText(conveyorState?.type === "conveyor" ? conveyorState.fault : null);
    conveyors.push({
      id: c.id,
      name: c.name,
      transform: toRendererTransform(frame),
      length: c.length * MM,
      width: c.width * MM,
      fault,
    });
    addFault(c.id, 0, fault, lifted(toMcs(frame, [c.length / 2, 0, 0]), LABEL_LIFT.conveyor));
    const owner = snapOwner(c, frame);
    snapPoints.push(owner.at(`${c.name} · origin`, shiftOf(c)));
    for (const end of ["start", "end"] as const) {
      for (const [side, y] of sides(c.width)) {
        snapPoints.push(owner.at(`${c.name} · ${end}, ${side}`, [end === "start" ? 0 : c.length, y, 0]));
      }
    }
    snapPoints.push(owner.at(`${c.name} · end centre`, [c.length, 0, 0]));
    const state = states.get(c.id);
    if (state?.type === "conveyor") {
      const shown = conveyorProducts(c, frame, state, carriers, (message) => warnings.push(message));
      products.push(...shown);
      for (const p of shown) snapPoints.push(...productSnapPoints(p, owner));
    }
  }
  // Each component's coordinate system: at its pose, moved by its origin shift. Conveyors first, then Deltas.
  const order = (c: ComponentConfig) => (c.type === "conveyor" ? 0 : c.type === "delta" ? 1 : 2);
  const origins: SceneOrigin[] = [...(config?.components ?? [])]
    .sort((a, b) => order(a) - order(b))
    .map((c) => ({ componentId: c.id, name: c.name, transform: toRendererTransform(originFrame(c)) }));
  // Hidden components are built too (a hidden robot still carries products of a visible conveyor), then dropped.
  const shown = (id: number) => !hidden.has(id);
  return {
    conveyors: conveyors.filter((c) => shown(c.id)),
    products: products.filter((p) => shown(p.conveyorId)),
    deltas: deltas.filter((d) => shown(d.id)),
    workingAreas: workingAreas.filter((a) => shown(a.robotId)),
    zones,
    gantries: gantries.filter((g) => shown(g.id)),
    boxAreas: boxAreas.filter((a) => shown(a.robotId)),
    limitAreas: limitAreas.filter((a) => shown(a.robotId)),
    loops: loops.filter((l) => shown(l.id)),
    cartesians: cartesians.filter((c) => shown(c.id)),
    fingers: fingers.filter((f) => shown(f.robotId)),
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
export function buildMachineScene(sources: readonly SceneSource[], hidden: ReadonlySet<string>): MachineScene {
  const built = sources.map(({ sourceId, config, snapshots, renderTime, online }) => {
    const ids = (config?.components ?? []).map((c) => c.id);
    const hiddenIds = new Set(hidden.has(sourceId) ? ids : ids.filter((id) => hidden.has(componentKey(sourceId, id))));
    return { sourceId, online, scene: buildScene(config, snapshots, renderTime, hiddenIds) };
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

/** Bottom corners and bottom centre of a drawn product (not of a placeholder), in belt coordinates. */
function productSnapPoints(p: SceneProduct, owner: SnapOwner): SnapPoint[] {
  if (p.display === "placeholder") return [];
  const length = p.size.length / MM;
  const width = p.size.width / MM;
  const bottom = p.bottom;
  const name = `Product #${p.productId}`;
  const corner = (label: string, x: number, y: number) =>
    owner.atMcs(`${name} · ${label}`, toMcs(bottom, [x, y, 0]), "structure", true);
  return [
    corner("front left", length / 2, width / 2),
    corner("front right", length / 2, -width / 2),
    corner("back left", -length / 2, width / 2),
    corner("back right", -length / 2, -width / 2),
    corner("bottom centre", 0, 0),
  ];
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
  perimeters: ReadonlyMap<number, number>,
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
    result.set(c.id, n && n.type === c.type ? interpolate(c, n, f, perimeters.get(c.id) ?? 0) : c);
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

function interpolate(a: ComponentState, b: ComponentState, f: number, perimeter: number): ComponentState {
  if (a.type === "xtsGantry" && b.type === "xtsGantry") {
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
  }
  if (a.type === "xtsLoop" && b.type === "xtsLoop") {
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
  }
  if (a.type === "cartesian" && b.type === "cartesian") {
    return {
      ...a,
      x: lerp(a.x, b.x, f),
      y: lerp(a.y, b.y, f),
      z: lerp(a.z, b.z, f),
      fingers: lerpFingers(a.fingers, b.fingers, f),
    };
  }
  if (a.type === "conveyor" && b.type === "conveyor") return { ...a, beltPosition: lerp(a.beltPosition, b.beltPosition, f) };
  if (a.type === "delta" && b.type === "delta") {
    return {
      ...a,
      actualTcp: lerpPosition(a.actualTcp, b.actualTcp, f),
      setpointTcp: lerpPosition(a.setpointTcp, b.setpointTcp, f),
      fingers: lerpFingers(a.fingers, b.fingers, f),
    };
  }
  return a;
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

/**
 * Products of one conveyor register, positioned by latch + belt travel, with the display lifecycle:
 * - picked/placed: a placeholder keeps travelling on the belt (until the belt end);
 *   while picked, the product itself hangs below its robot's TCP.
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
    const type = c.productTypes.find((t) => t.id === p.productType) ?? DEFAULT_PRODUCT;
    const size = { length: type.length * MM, width: type.width * MM, height: type.height * MM };
    const travel = state.beltPosition - p.latchBeltPosition;
    const bottom: Vec3 = [
      p.latchPose.x + direction[0] * travel,
      p.latchPose.y + direction[1] * travel,
      p.latchPose.z + direction[2] * travel,
    ];
    const shown = (display: ProductDisplay, frame: Frame): SceneProduct => ({
      key: `${c.id}:${p.id}:${display}`,
      productId: p.id,
      conveyorId: c.id,
      display,
      state: p.state,
      transform: toRendererTransform({ rotation: frame.rotation, origin: toMcs(frame, [0, 0, type.height / 2]) }),
      bottom: frame,
      size,
      raw: p,
    });
    const onBelt = (display: ProductDisplay) =>
      shown(display, { rotation: rotZ(p.latchPose.rz), origin: [bottom[0], bottom[1], bottom[2]] });

    const beltX =
      (bottom[0] - frame.origin[0]) * direction[0] +
      (bottom[1] - frame.origin[1]) * direction[1] +
      (bottom[2] - frame.origin[2]) * direction[2];
    const beyondEnd = beltX > c.length;

    if (p.state === "picked" || p.state === "placed") {
      if (!beyondEnd) result.push(onBelt("placeholder"));
      let carrier: Frame | undefined;
      if (p.state === "picked") {
        const flange = carriers.get(`${p.robotId}:${p.moverId}`);
        carrier = p.fingerId > 0 ? carriers.get(`${p.robotId}:${p.moverId}:${p.fingerId}`) : flange;
        if (!carrier && flange) {
          // An unknown finger: hang it at the flange so it stays visible.
          warn(`${c.name}: product #${p.id} hangs from finger ${p.fingerId}, which robot #${p.robotId} does not have`);
          carrier = flange;
        }
      }
      if (carrier) {
        // Hanging from the carrier: the product's top touches the carrier origin.
        result.push(shown("atTcp", { rotation: carrier.rotation, origin: toMcs(carrier, [0, 0, -type.height]) }));
      }
      continue;
    }
    if (!beyondEnd) {
      result.push(onBelt("normal"));
    } else if (p.state !== "rejected") {
      // Unpicked past the end: hold it at the belt end, flagged, until the PLC drops the entry.
      // Rejected products pass the end on purpose and are not flagged.
      const back = beltX - (c.length - type.length / 2);
      bottom[0] -= direction[0] * back;
      bottom[1] -= direction[1] * back;
      bottom[2] -= direction[2] * back;
      result.push(onBelt("missed"));
    }
  }
  return result;
}

/** Mover frames of an XTS gantry, its reachable volume, snap points and the frames products hang from. */
function buildGantry(c: XtsGantryConfig, state: XtsGantryState | undefined) {
  const frame = frameFromPose(c.pose);
  const z = state?.z ?? 0;
  const trackLength = c.moduleCount * c.moduleLength;
  const owner = snapOwner(c, frame);
  const carriers = new Map<number, Frame>();
  const grippers: GripperSource[] = [];
  const gantryFault = faultText(state?.fault);
  const faults = [
    { moverId: 0, message: gantryFault, anchor: lifted(toMcs(frame, [0, trackLength / 2, z]), LABEL_LIFT.track) },
  ];
  const snapPoints: SnapPoint[] = [
    owner.at(`${c.name} · track start`, [0, 0, z], "structure", true),
    ...Array.from({ length: Math.max(0, c.moduleCount - 1) }, (_, i) =>
      owner.at(`${c.name} · module boundary ${i + 1}`, [0, (i + 1) * c.moduleLength, z], "structure", true),
    ),
    owner.at(`${c.name} · track end`, [0, trackLength, z], "structure", true),
  ];
  const movers = (state?.movers ?? []).map((m): SceneGantryMover => {
    const toolX = m.x + c.toolOffsetX;
    const tip = child(frame, [toolX, m.position, z + c.toolOffsetZ]);
    carriers.set(m.id, tip);
    const fault = faultText(m.fault);
    const carriage = toMcs(frame, [0, m.position, z]);
    faults.push({ moverId: m.id, message: fault, anchor: lifted(carriage, LABEL_LIFT.gantryMover) });
    grippers.push({ moverId: m.id, flange: tip, states: m.fingers, faulted: gantryFault !== null || fault !== null });
    snapPoints.push(owner.atMcs(`${c.name} · mover ${m.id} flange`, tip.origin, "structure", true));
    return {
      id: m.id,
      carriage: toRenderer(carriage),
      armEnd: toRenderer(toMcs(frame, [toolX, m.position, z])),
      tip: toRendererTransform(tip),
      gripperActive: c.fingers.length === 0 && m.gripperActive,
      fault,
    };
  });
  const centre: Vec3 = [
    (c.xMin + c.xMax) / 2 + c.toolOffsetX,
    trackLength / 2,
    (c.zMin + c.zMax) / 2 + c.toolOffsetZ,
  ];
  return {
    gantry: {
      id: c.id,
      name: c.name,
      track: toRendererTransform(child(frame, [0, 0, z])),
      trackLength: trackLength * MM,
      moduleLength: c.moduleLength * MM,
      moduleCount: c.moduleCount,
      moverLength: c.moverLength * MM,
      moverWidth: c.moverWidth * MM,
      movers,
      fault: gantryFault,
    } satisfies SceneGantry,
    area: {
      robotId: c.id,
      transform: toRendererTransform(child(frame, centre)),
      size: [(c.xMax - c.xMin) * MM, trackLength * MM, (c.zMax - c.zMin) * MM],
    } satisfies SceneBoxArea,
    snapPoints,
    carriers,
    grippers,
    faults,
  };
}

function loopPerimeter(c: XtsLoopConfig): number {
  return 2 * c.straightLength + 2 * Math.PI * c.curveRadius;
}

/**
 * Point and unit tangent at track position s on an XTS loop, in its local frame (mm): lower straight along +X from
 * the origin, a semicircle up at the far end, the upper straight back along −X at +2R, a semicircle down at the start.
 */
export function loopPoint(c: Pick<XtsLoopConfig, "straightLength" | "curveRadius">, s: number) {
  const L = c.straightLength;
  const R = c.curveRadius;
  const perimeter = 2 * L + 2 * Math.PI * R;
  const u = perimeter > 0 ? ((s % perimeter) + perimeter) % perimeter : 0;
  const arc = Math.PI * R;
  if (u <= L) return { point: [u, 0, 0] as Vec3, tangent: [1, 0, 0] as Vec3 };
  if (u <= L + arc) {
    const a = (u - L) / R;
    return { point: [L + R * Math.sin(a), 0, R - R * Math.cos(a)] as Vec3, tangent: [Math.cos(a), 0, Math.sin(a)] as Vec3 };
  }
  if (u <= 2 * L + arc) return { point: [L - (u - L - arc), 0, 2 * R] as Vec3, tangent: [-1, 0, 0] as Vec3 };
  const a = (u - 2 * L - arc) / R;
  return { point: [-R * Math.sin(a), 0, R + R * Math.cos(a)] as Vec3, tangent: [-Math.cos(a), 0, -Math.sin(a)] as Vec3 };
}

/** Mover frames of an XTS loop, snap points and the frames products hang from. */
function buildLoop(c: XtsLoopConfig, state: XtsLoopState | undefined) {
  const frame = frameFromPose(c.pose);
  const owner = snapOwner(c, frame);
  const L = c.straightLength;
  const R = c.curveRadius;
  const carriers = new Map<number, Frame>();
  const grippers: GripperSource[] = [];
  const loopFault = faultText(state?.fault);
  const faults = [{ moverId: 0, message: loopFault, anchor: lifted(toMcs(frame, [L / 2, 0, 2 * R]), LABEL_LIFT.track) }];
  const snapPoints: SnapPoint[] = [
    owner.at(`${c.name} · lower straight, start`, [0, 0, 0]),
    owner.at(`${c.name} · lower straight, end`, [L, 0, 0]),
    owner.at(`${c.name} · upper straight, start side`, [0, 0, 2 * R]),
    owner.at(`${c.name} · upper straight, end side`, [L, 0, 2 * R]),
    owner.at(`${c.name} · curve centre, start side`, [0, 0, R]),
    owner.at(`${c.name} · curve centre, end side`, [L, 0, R]),
  ];
  const movers = (state?.movers ?? []).map((m): SceneLoopMover => {
    const { point, tangent } = loopPoint(c, m.position);
    // Turn about local Y so that the mover's +X follows the tangent; its −Z then points outwards.
    const angle = (Math.atan2(-tangent[2], tangent[0]) * 180) / Math.PI;
    const mover = child(frame, point, rotY(angle));
    const tool = child(mover, [0, 0, -c.toolOffset]);
    carriers.set(m.id, tool);
    const fault = faultText(m.fault);
    faults.push({ moverId: m.id, message: fault, anchor: lifted(mover.origin, LABEL_LIFT.loopMover) });
    grippers.push({ moverId: m.id, flange: tool, states: m.fingers, faulted: loopFault !== null || fault !== null });
    snapPoints.push(owner.atMcs(`${c.name} · mover ${m.id} tool`, tool.origin, "structure", true));
    return { id: m.id, transform: toRendererTransform(mover), tool: toRenderer(tool.origin), fault };
  });
  return {
    loop: {
      id: c.id,
      name: c.name,
      base: toRendererTransform(frame),
      straightLength: L * MM,
      curveRadius: R * MM,
      moverLength: c.moverLength * MM,
      moverWidth: c.moverWidth * MM,
      movers,
      fault: loopFault,
    } satisfies SceneLoop,
    snapPoints,
    carriers,
    grippers,
    faults,
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
