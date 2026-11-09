/**
 * Rigid transforms in the MCS (mm, degrees, Z up) and the conversion to the renderer frame
 * (Three.js: metres, Y up). Internal to the scene model.
 */
import type { Pose } from "@rpp/protocol";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
/** Row-major 3×3 rotation matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface Frame {
  rotation: Mat3;
  /** Origin in MCS mm. */
  origin: Vec3;
}

const DEG = Math.PI / 180;

export function rotX(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function rotY(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export function rotZ(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return r;
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Pose → frame. Rotation order per contract: R = Rz(rz) · Ry(ry) · Rx(rx). */
export function frameFromPose(p: Pose): Frame {
  return { rotation: mul(rotZ(p.rz), mul(rotY(p.ry), rotX(p.rx))), origin: [p.x, p.y, p.z] };
}

/** Point given in a frame's local coordinates (mm) → MCS (mm). */
export function toMcs(frame: Frame, local: Vec3): Vec3 {
  const r = apply(frame.rotation, local);
  return [r[0] + frame.origin[0], r[1] + frame.origin[1], r[2] + frame.origin[2]];
}

/** MCS point (mm) → coordinates in a frame's local axes (mm): Rᵀ · (p − origin). */
export function toLocal(frame: Frame, p: Vec3): Vec3 {
  const d: Vec3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
  const r = frame.rotation;
  return [
    r[0] * d[0] + r[3] * d[1] + r[6] * d[2],
    r[1] * d[0] + r[4] * d[1] + r[7] * d[2],
    r[2] * d[0] + r[5] * d[1] + r[8] * d[2],
  ];
}

/** Child frame placed at `local` inside `parent`, additionally rotated by `rotation` (local). */
export function child(parent: Frame, local: Vec3, rotation: Mat3 = rotZ(0)): Frame {
  return { rotation: mul(parent.rotation, rotation), origin: toMcs(parent, local) };
}

/** MCS mm (Z up) → renderer metres (Y up): (x, y, z) ↦ (x, z, −y) / 1000. */
export function toRenderer(p: Vec3): Vec3 {
  return [p[0] / 1000, p[2] / 1000, -p[1] / 1000];
}

/** Renderer metres (Y up) → MCS mm (Z up): inverse of `toRenderer`. */
export function fromRenderer(p: Vec3): Vec3 {
  return [p[0] * 1000, -p[2] * 1000, p[1] * 1000];
}

/** Change of basis MCS → renderer, applied to rotations as C · R · Cᵀ. */
const C: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const CT: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];

export function quatFromMat3(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return q;
}

export interface Transform {
  /** Renderer metres. */
  position: Vec3;
  /** Renderer quaternion [x, y, z, w]. */
  quaternion: Quat;
}

/**
 * Frame → renderer transform. An object's local axes map like the world axes: local +X stays +X,
 * local +Z (MCS up) becomes +Y, local +Y becomes −Z.
 */
export function toRendererTransform(frame: Frame): Transform {
  return { position: toRenderer(frame.origin), quaternion: quatFromMat3(mul(C, mul(frame.rotation, CT))) };
}

/** A box along the axes of a frame: from `min` to `max` in its local coordinates, mm. */
export interface FrameBox {
  frame: Frame;
  min: Vec3;
  max: Vec3;
}

/** How far boxes may reach into each other and still count as only touching, mm. */
const TOUCH = 1e-6;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A box as centre, unit axes and half sizes, all in the MCS. */
function oriented(b: FrameBox) {
  const r = b.frame.rotation;
  return {
    centre: toMcs(b.frame, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]),
    axes: [0, 1, 2].map((i) => [r[i]!, r[3 + i]!, r[6 + i]!] as Vec3),
    half: [0, 1, 2].map((i) => (b.max[i]! - b.min[i]!) / 2),
  };
}

/**
 * Whether two boxes overlap, however their frames are turned (separating axis test); boxes that only touch do not. A
 * flat box (min = max along an axis) overlaps a box it cuts through.
 */
export function boxesOverlap(a: FrameBox, b: FrameBox): boolean {
  const p = oriented(a);
  const q = oriented(b);
  const between: Vec3 = [q.centre[0] - p.centre[0], q.centre[1] - p.centre[1], q.centre[2] - p.centre[2]];
  const candidates = [...p.axes, ...q.axes, ...p.axes.flatMap((u) => q.axes.map((v) => cross(u, v)))];
  for (const axis of candidates) {
    const length = Math.hypot(...axis);
    // Parallel edges give no axis of their own: the face axes cover them.
    if (length < 1e-9) continue;
    const reach = (box: typeof p) => box.axes.reduce((sum, u, i) => sum + box.half[i]! * Math.abs(dot(u, axis)), 0);
    if (Math.abs(dot(between, axis)) >= reach(p) + reach(q) - TOUCH * length) return false;
  }
  return true;
}

/** Whether box `inner` lies wholly in box `outer`, both given in the same frame; touching faces still count as in. */
export function boxInside(inner: FrameBox, outer: FrameBox): boolean {
  return [0, 1, 2].every((i) => inner.min[i]! >= outer.min[i]! - TOUCH && inner.max[i]! <= outer.max[i]! + TOUCH);
}
