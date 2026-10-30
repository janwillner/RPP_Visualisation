import {
  deltaForward,
  deltaInverse,
  type ComponentState,
  type ConfigMessage,
  type ConveyorConfig,
  type ConveyorState,
  type DeltaConfig,
  type DeltaState,
  type PlanarPose,
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
  /** Effector centre at the actual TCP, rotated by the TCP's rz when the robot has a rotation axis. */
  effector: Transform | null;
  /** False when the arms cannot reach the reported TCP (the effector is still drawn at the TCP). */
  reachable: boolean;
  /** TCPs reported by the PLC; null before the first state arrives. */
  actualTcp: Vec3 | null;
  setpointTcp: Vec3 | null;
  /** Upper-arm angles in degrees computed from the TCP (angle convention of the contract); empty if unreachable. */
  angles: number[];
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
}

export interface SceneGantryMover {
  id: number;
  /** Mover centre on the track. */
  carriage: Vec3;
  /** End of the X arm, straight above the gripper tip. */
  armEnd: Vec3;
  /** Gripper tip (TCP), turned by C; local +X is the gripper's orientation, local +Y up. */
  tip: Transform;
  gripperActive: boolean;
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
}

/** An axis-aligned box in a component's frame, e.g. the reachable volume of an XTS gantry. */
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
  /** Tool point, where a carried product hangs. */
  tool: Vec3;
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
}

/** Which layer toggle a snap point belongs to; "structure" is always shown. */
export type SnapLayer = "structure" | "zones" | "workingAreas";

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

export interface SceneModel {
  conveyors: SceneConveyor[];
  products: SceneProduct[];
  deltas: SceneDelta[];
  workingAreas: SceneWorkingArea[];
  zones: SceneZone[];
  gantries: SceneGantry[];
  gantryAreas: SceneBoxArea[];
  loops: SceneLoop[];
  snapPoints: SnapPoint[];
  origins: SceneOrigin[];
  /** Inconsistencies in the configuration, e.g. a zone referencing an unknown conveyor. */
  warnings: string[];
}

const MM = 1 / 1000;
const DEFAULT_PRODUCT: ProductType = { id: 0, length: 100, width: 100, height: 100 };

export function buildScene(
  config: ConfigMessage | undefined,
  snapshots: readonly StateMessage[],
  renderTime: number,
): SceneModel {
  const perimeters = new Map<number, number>();
  for (const c of config?.components ?? []) if (c.type === "xtsLoop") perimeters.set(c.id, loopPerimeter(c));
  const states = sampleStates(snapshots, renderTime, perimeters);
  const conveyors: SceneConveyor[] = [];
  const products: SceneProduct[] = [];
  const deltas: SceneDelta[] = [];
  const gantries: SceneGantry[] = [];
  const gantryAreas: SceneBoxArea[] = [];
  const loops: SceneLoop[] = [];
  /**
   * Where a picked product hangs, keyed "robotId:moverId" (mover 0 for a Delta): an MCS frame whose origin
   * touches the product's top, whose rotation orients the product and whose local −Z points to the product.
   */
  const carriers = new Map<string, Frame>();

  const workingAreas: SceneWorkingArea[] = [];
  const zones: SceneZone[] = [];
  const warnings: string[] = [];
  const snapPoints: SnapPoint[] = [];
  const conveyorConfigs = new Map<number, ConveyorConfig>();
  for (const c of config?.components ?? []) if (c.type === "conveyor") conveyorConfigs.set(c.id, c);

  const addZones = (c: { id: number; name: string; zones: Zone[] }) => {
    for (const win of c.zones) {
      const belt = conveyorConfigs.get(win.conveyorId);
      if (!belt) {
        warnings.push(`${c.name}: ${win.kind} zone references unknown conveyor ${win.conveyorId}`);
        continue;
      }
      zones.push({
        robotId: c.id,
        conveyorId: belt.id,
        kind: win.kind,
        transform: toRendererTransform(child(frameFromPose(belt.pose), [(win.start + win.end) / 2, 0, 0])),
        length: Math.abs(win.end - win.start) * MM,
        width: belt.width * MM,
      });
      const owner = snapOwner(belt, frameFromPose(belt.pose));
      const name = `${c.name} ${win.kind} zone on ${belt.name}`;
      for (const [side, y] of sides(belt.width)) {
        snapPoints.push(owner.at(`${name} · start, ${side}`, [win.start, y, 0], "zones"));
        snapPoints.push(owner.at(`${name} · end, ${side}`, [win.end, y, 0], "zones"));
      }
    }
  };

  for (const c of config?.components ?? []) {
    const state = states.get(c.id);
    if (c.type === "xtsGantry") {
      const built = buildGantry(c, state?.type === "xtsGantry" ? state : undefined);
      gantries.push(built.gantry);
      gantryAreas.push(built.area);
      snapPoints.push(...built.snapPoints);
      for (const [moverId, frame] of built.carriers) carriers.set(`${c.id}:${moverId}`, frame);
      addZones(c);
      continue;
    }
    if (c.type === "xtsLoop") {
      const built = buildLoop(c, state?.type === "xtsLoop" ? state : undefined);
      loops.push(built.loop);
      snapPoints.push(...built.snapPoints);
      for (const [moverId, frame] of built.carriers) carriers.set(`${c.id}:${moverId}`, frame);
      addZones(c);
      continue;
    }
    if (c.type !== "delta") continue;
    const deltaState = state?.type === "delta" ? state : undefined;
    deltas.push(buildDelta(c, deltaState));
    if (deltaState) {
      const tcp = deltaState.actualTcp;
      carriers.set(`${c.id}:0`, { rotation: rotZ(tcp.rz), origin: planarToMcs(tcp) });
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
    addZones(c);
  }

  for (const c of config?.components ?? []) {
    if (c.type !== "conveyor") continue;
    const frame = frameFromPose(c.pose);
    conveyors.push({
      id: c.id,
      name: c.name,
      transform: toRendererTransform(frame),
      length: c.length * MM,
      width: c.width * MM,
    });
    const owner = snapOwner(c, frame);
    snapPoints.push(owner.at(`${c.name} · origin`, [0, 0, 0]));
    for (const end of ["start", "end"] as const) {
      for (const [side, y] of sides(c.width)) {
        snapPoints.push(owner.at(`${c.name} · ${end}, ${side}`, [end === "start" ? 0 : c.length, y, 0]));
      }
    }
    snapPoints.push(owner.at(`${c.name} · end centre`, [c.length, 0, 0]));
    const state = states.get(c.id);
    if (state?.type === "conveyor") {
      const shown = conveyorProducts(c, frame, state, carriers);
      products.push(...shown);
      for (const p of shown) snapPoints.push(...productSnapPoints(p, owner));
    }
  }
  const origins: SceneOrigin[] = [
    ...conveyors.map((c) => ({ componentId: c.id, name: c.name, transform: c.transform })),
    ...deltas.map((d) => ({ componentId: d.id, name: d.name, transform: d.base })),
    ...(config?.components ?? [])
      .filter((c) => c.type === "xtsGantry" || c.type === "xtsLoop")
      .map((c) => ({ componentId: c.id, name: c.name, transform: toRendererTransform(frameFromPose(c.pose)) })),
  ];
  return {
    conveyors,
    products,
    deltas,
    workingAreas,
    zones,
    gantries,
    gantryAreas,
    loops,
    snapPoints,
    origins,
    warnings,
  };
}

/** Left (local +Y) and right edge of a belt of the given width. */
function sides(width: number): [string, number][] {
  return [
    ["left", width / 2],
    ["right", -width / 2],
  ];
}

type SnapOwner = ReturnType<typeof snapOwner>;

/** Creates the snap points of one component; local coordinates are in its frame. */
function snapOwner(component: { id: number; name: string }, frame: Frame) {
  const make = (label: string, mcs: Vec3, layer: SnapLayer, moving: boolean): SnapPoint => ({
    key: `${component.id}:${label}`,
    label,
    mcs,
    position: toRenderer(mcs),
    local: { componentId: component.id, componentName: component.name, point: toLocal(frame, mcs) },
    layer,
    moving,
  });
  return {
    /** A point given in the component's local frame. */
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
  if (state) points.push(owner.atMcs(`${c.name} · TCP`, planarToMcs(state.actualTcp), "structure", true));
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
  layers: { zones: boolean; workingAreas: boolean },
): SnapPoint[] {
  return points.filter((p) => p.layer === "structure" || layers[p.layer]);
}

/** Per measuring point: offset and distance to the previous point (none for the first). */
export function measureChain(points: readonly Vec3[]): { delta: Vec3 | undefined; distance: number | undefined }[] {
  return points.map((p, i) => {
    const prev = points[i - 1];
    if (!prev) return { delta: undefined, distance: undefined };
    const delta: Vec3 = [p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]];
    return { delta, distance: Math.hypot(...delta) };
  });
}

/** "X;Y;Z" with 0.1 mm, for the clipboard. */
export function formatPointCopy(p: Vec3): string {
  return p.map((v) => v.toFixed(1)).join(";");
}

/** All measuring points as CSV (semicolon separated), with the distance to the previous point. */
export function pointsCsv(points: readonly { id: number; label: string; mcs: Vec3 }[]): string {
  const chain = measureChain(points.map((p) => p.mcs));
  const rows = points.map(
    (p, i) => `${p.id};${p.label};${formatPointCopy(p.mcs)};${chain[i]!.distance?.toFixed(1) ?? ""}`,
  );
  return ["#;label;x;y;z;distance", ...rows].join("\n");
}

function planarToMcs(p: PlanarPose): Vec3 {
  return [p.x, p.y, p.z];
}

/**
 * The PLC reports only the TCP (effector centre); the arms follow it by inverse kinematics in the robot frame.
 * Before the first state the robot is drawn with horizontal upper arms.
 */
function buildDelta(c: DeltaConfig, state: DeltaState | undefined): SceneDelta {
  const frame = frameFromPose(c.pose);
  const world = (local: Vec3) => toRenderer(toMcs(frame, local));
  const localTcp = state ? toLocal(frame, planarToMcs(state.actualTcp)) : undefined;
  const angles = localTcp ? deltaInverse(c, localTcp) : [0, 0, 0];
  const posture = deltaForward(c, (angles ?? [0, 0, 0]) as [number, number, number]);
  // The TCP's rz is absolute in the MCS; the effector rotates about the base's Z axis.
  const effectorRotation = c.hasRotationAxis && state ? state.actualTcp.rz - c.pose.rz : 0;
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
    effector: effectorCentre ? toRendererTransform(child(frame, effectorCentre, rotZ(effectorRotation))) : null,
    reachable: angles !== null,
    actualTcp: state ? toRenderer(planarToMcs(state.actualTcp)) : null,
    setpointTcp: state ? toRenderer(planarToMcs(state.setpointTcp)) : null,
    angles: angles ?? [],
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
          ? { ...m, position: lerp(m.position, n.position, f), x: lerp(m.x, n.x, f), c: lerpAngle(m.c, n.c, f) }
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
        return n ? { ...m, position: lerpWrapped(m.position, n.position, f, perimeter) } : m;
      }),
    };
  }
  if (a.type === "conveyor" && b.type === "conveyor") return { ...a, beltPosition: lerp(a.beltPosition, b.beltPosition, f) };
  if (a.type === "delta" && b.type === "delta") {
    return {
      ...a,
      actualTcp: lerpPlanar(a.actualTcp, b.actualTcp, f),
      setpointTcp: lerpPlanar(a.setpointTcp, b.setpointTcp, f),
    };
  }
  return a;
}

function lerpPlanar(a: PlanarPose, b: PlanarPose, f: number): PlanarPose {
  return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f), rz: lerpAngle(a.rz, b.rz, f) };
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
      const carrier = p.state === "picked" ? carriers.get(`${p.robotId}:${p.moverId}`) : undefined;
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
  const snapPoints: SnapPoint[] = [
    owner.at(`${c.name} · track start`, [0, 0, z], "structure", true),
    ...Array.from({ length: Math.max(0, c.moduleCount - 1) }, (_, i) =>
      owner.at(`${c.name} · module boundary ${i + 1}`, [0, (i + 1) * c.moduleLength, z], "structure", true),
    ),
    owner.at(`${c.name} · track end`, [0, trackLength, z], "structure", true),
  ];
  const movers = (state?.movers ?? []).map((m): SceneGantryMover => {
    const toolX = m.x + c.toolOffsetX;
    const tip = child(frame, [toolX, m.position, z + c.toolOffsetZ], rotZ(m.c));
    carriers.set(m.id, tip);
    snapPoints.push(owner.atMcs(`${c.name} · mover ${m.id} gripper`, tip.origin, "structure", true));
    return {
      id: m.id,
      carriage: toRenderer(toMcs(frame, [0, m.position, z])),
      armEnd: toRenderer(toMcs(frame, [toolX, m.position, z])),
      tip: toRendererTransform(tip),
      gripperActive: m.gripperActive,
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
    } satisfies SceneGantry,
    area: {
      robotId: c.id,
      transform: toRendererTransform(child(frame, centre)),
      size: [(c.xMax - c.xMin) * MM, trackLength * MM, (c.zMax - c.zMin) * MM],
    } satisfies SceneBoxArea,
    snapPoints,
    carriers,
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
    snapPoints.push(owner.atMcs(`${c.name} · mover ${m.id} tool`, tool.origin, "structure", true));
    return { id: m.id, transform: toRendererTransform(mover), tool: toRenderer(tool.origin) };
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
    } satisfies SceneLoop,
    snapPoints,
    carriers,
  };
}
