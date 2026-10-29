import {
  deltaForward,
  toConventionalAngle,
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
  type WindowKind,
} from "@rpp/protocol";
import {
  apply,
  child,
  frameFromPose,
  rotZ,
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
  size: Size;
  /** Register entry as reported by the PLC. */
  raw: Product;
}

export interface SceneDelta {
  id: number;
  name: string;
  /** Base centre; local axes as in the robot's frame. */
  base: Transform;
  /** World positions, one per arm. */
  shoulders: Vec3[];
  elbows: Vec3[];
  /** Lower-arm joints on the effector; empty when unreachable. */
  effectorJoints: Vec3[];
  /** Effector centre, rotated by the 4th axis when present; null when unreachable. */
  effector: Transform | null;
  reachable: boolean;
  /** TCPs reported by the PLC; null before the first state arrives. */
  actualTcp: Vec3 | null;
  setpointTcp: Vec3 | null;
  /** Conventional angles in degrees (after offset and direction). */
  angles: number[];
}

export interface SceneWorkArea {
  robotId: number;
  /** Robot base frame; the cylinder axis is local +Y, heights relative to the base. */
  transform: Transform;
  radius: number;
  zMin: number;
  zMax: number;
  coneHeight: number;
  coneBottomRadius: number;
}

export interface SceneWindow {
  robotId: number;
  conveyorId: number;
  kind: WindowKind;
  /** Centre of the window on the belt surface; extends along local +X. */
  transform: Transform;
  length: number;
  width: number;
}

export interface SceneModel {
  conveyors: SceneConveyor[];
  products: SceneProduct[];
  deltas: SceneDelta[];
  workAreas: SceneWorkArea[];
  windows: SceneWindow[];
  /** Inconsistencies in the configuration, e.g. a window referencing an unknown conveyor. */
  warnings: string[];
}

const MM = 1 / 1000;
const DEFAULT_PRODUCT: ProductType = { id: 0, length: 100, width: 100, height: 100 };

export function buildScene(
  config: ConfigMessage | undefined,
  snapshots: readonly StateMessage[],
  renderTime: number,
): SceneModel {
  const states = sampleStates(snapshots, renderTime);
  const conveyors: SceneConveyor[] = [];
  const products: SceneProduct[] = [];
  const deltas: SceneDelta[] = [];
  /** Actual TCP per robot id, for products carried by a robot. */
  const tcps = new Map<number, PlanarPose>();

  const workAreas: SceneWorkArea[] = [];
  const windows: SceneWindow[] = [];
  const warnings: string[] = [];
  const conveyorConfigs = new Map<number, ConveyorConfig>();
  for (const c of config?.components ?? []) if (c.type === "conveyor") conveyorConfigs.set(c.id, c);

  for (const c of config?.components ?? []) {
    if (c.type !== "delta") continue;
    const state = states.get(c.id);
    const deltaState = state?.type === "delta" ? state : undefined;
    deltas.push(buildDelta(c, deltaState));
    if (deltaState) tcps.set(c.id, deltaState.actualTcp);

    const w = c.workArea;
    workAreas.push({
      robotId: c.id,
      transform: toRendererTransform(frameFromPose(c.pose)),
      radius: w.radius * MM,
      zMin: w.zMin * MM,
      zMax: w.zMax * MM,
      coneHeight: w.coneHeight * MM,
      coneBottomRadius: w.coneBottomRadius * MM,
    });

    for (const win of c.windows) {
      const belt = conveyorConfigs.get(win.conveyorId);
      if (!belt) {
        warnings.push(`${c.name}: ${win.kind} window references unknown conveyor ${win.conveyorId}`);
        continue;
      }
      windows.push({
        robotId: c.id,
        conveyorId: belt.id,
        kind: win.kind,
        transform: toRendererTransform(child(frameFromPose(belt.pose), [(win.start + win.end) / 2, 0, 0])),
        length: Math.abs(win.end - win.start) * MM,
        width: belt.width * MM,
      });
    }
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
    const state = states.get(c.id);
    if (state?.type === "conveyor") products.push(...conveyorProducts(c, frame, state, tcps));
  }
  return { conveyors, products, deltas, workAreas, windows, warnings };
}

function planarToMcs(p: PlanarPose): Vec3 {
  return [p.x, p.y, p.z];
}

function buildDelta(c: DeltaConfig, state: DeltaState | undefined): SceneDelta {
  const frame = frameFromPose(c.pose);
  const raw = state?.axes ?? [0, 0, 0, 0];
  const angles = c.axes.map((calibration, i) => toConventionalAngle(raw[i] ?? 0, calibration));
  const posture = deltaForward(c, [angles[0]!, angles[1]!, angles[2]!]);
  const world = (local: Vec3) => toRenderer(toMcs(frame, local));
  const effectorRotation = c.hasRotationAxis ? (angles[3] ?? 0) : 0;
  return {
    id: c.id,
    name: c.name,
    base: toRendererTransform(frame),
    shoulders: posture.shoulders.map(world),
    elbows: posture.elbows.map(world),
    effectorJoints: posture.effectorJoints.map(world),
    effector: posture.effector ? toRendererTransform(child(frame, posture.effector, rotZ(effectorRotation))) : null,
    reachable: posture.effector !== null,
    actualTcp: state ? toRenderer(planarToMcs(state.actualTcp)) : null,
    setpointTcp: state ? toRenderer(planarToMcs(state.setpointTcp)) : null,
    angles,
  };
}

/**
 * Component states at `renderTime`: discrete data (register entries, states) from the snapshot at or
 * before `renderTime`, continuous values interpolated towards the next one. Outside the buffered
 * range the nearest snapshot is held; nothing is extrapolated.
 */
function sampleStates(snapshots: readonly StateMessage[], renderTime: number): Map<number, ComponentState> {
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
    result.set(c.id, n && n.type === c.type ? interpolate(c, n, f) : c);
  }
  return result;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** Interpolate degrees along the shorter way, so 179° → −179° passes through 180°, not 0°. */
function lerpAngle(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * f;
}

function interpolate(a: ComponentState, b: ComponentState, f: number): ComponentState {
  if (a.type === "conveyor" && b.type === "conveyor") return { ...a, encoder: lerp(a.encoder, b.encoder, f) };
  if (a.type === "delta" && b.type === "delta") {
    return {
      ...a,
      axes: a.axes.map((v, i) => lerpAngle(v, b.axes[i] ?? v, f)),
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
 * Products of one conveyor register, positioned by latch + encoder travel, with the display lifecycle:
 * - picked/placed: a placeholder keeps travelling on the belt (until the belt end);
 *   while picked, the product itself hangs below its robot's TCP.
 */
function conveyorProducts(
  c: ConveyorConfig,
  frame: Frame,
  state: ConveyorState,
  tcps: ReadonlyMap<number, PlanarPose>,
): SceneProduct[] {
  const direction = apply(frame.rotation, [1, 0, 0]);
  const result: SceneProduct[] = [];
  for (const p of state.products) {
    const type = c.productTypes.find((t) => t.id === p.productType) ?? DEFAULT_PRODUCT;
    const size = { length: type.length * MM, width: type.width * MM, height: type.height * MM };
    const travel = state.encoder - p.latchEncoder;
    const bottom: Vec3 = [
      p.latchPose.x + direction[0] * travel,
      p.latchPose.y + direction[1] * travel,
      p.latchPose.z + direction[2] * travel,
    ];
    const onBelt = (display: ProductDisplay): SceneProduct => ({
      key: `${c.id}:${p.id}:${display}`,
      productId: p.id,
      conveyorId: c.id,
      display,
      state: p.state,
      transform: toRendererTransform({
        rotation: rotZ(p.latchPose.rz),
        origin: [bottom[0], bottom[1], bottom[2] + type.height / 2],
      }),
      size,
      raw: p,
    });

    const beltX =
      (bottom[0] - frame.origin[0]) * direction[0] +
      (bottom[1] - frame.origin[1]) * direction[1] +
      (bottom[2] - frame.origin[2]) * direction[2];
    const beyondEnd = beltX > c.length;

    if (p.state === "picked" || p.state === "placed") {
      if (!beyondEnd) result.push(onBelt("placeholder"));
      const tcp = p.state === "picked" ? tcps.get(p.robotId) : undefined;
      if (tcp) {
        result.push({
          ...onBelt("atTcp"),
          transform: toRendererTransform({ rotation: rotZ(tcp.rz), origin: [tcp.x, tcp.y, tcp.z - type.height / 2] }),
        });
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
