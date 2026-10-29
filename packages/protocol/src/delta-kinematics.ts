/**
 * Delta robot kinematics in the robot's local frame (mm, degrees, Z up, origin at the base centre).
 *
 * Angle convention (part of the PLC contract):
 * - 0° = upper arm horizontal, positive angle = arm pointing downward.
 * - Arm 1 lies along local +X; arms 2 and 3 follow counter-clockwise (seen from above) at 120° each.
 * - Conventional angle = direction · raw + offset, per axis.
 */

export type Vec3 = [number, number, number];

export interface DeltaGeometry {
  baseRadius: number;
  effectorRadius: number;
  upperArmLength: number;
  lowerArmLength: number;
}

export interface DeltaAxisCalibration {
  offset: number;
  direction: 1 | -1;
}

export interface DeltaPosture {
  /** Shoulder joints on the base, one per arm. */
  shoulders: [Vec3, Vec3, Vec3];
  /** Elbow joints between upper and lower arm. */
  elbows: [Vec3, Vec3, Vec3];
  /** Lower-arm joints on the effector; empty when the posture is not reachable. */
  effectorJoints: Vec3[];
  /** Effector centre; null when the three lower arms cannot close. */
  effector: Vec3 | null;
}

const DEG = Math.PI / 180;
export const ARM_AZIMUTHS_DEG = [0, 120, 240] as const;

export function toConventionalAngle(raw: number, calibration: DeltaAxisCalibration): number {
  return calibration.direction * raw + calibration.offset;
}

export function toRawAngle(conventional: number, calibration: DeltaAxisCalibration): number {
  return (conventional - calibration.offset) * calibration.direction;
}

function radial(azimuthDeg: number): Vec3 {
  return [Math.cos(azimuthDeg * DEG), Math.sin(azimuthDeg * DEG), 0];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): number => Math.sqrt(dot(a, a));

/** Forward kinematics from three conventional upper-arm angles (degrees). */
export function deltaForward(geometry: DeltaGeometry, conventionalAngles: [number, number, number]): DeltaPosture {
  const { baseRadius, effectorRadius, upperArmLength, lowerArmLength } = geometry;
  const shoulders = ARM_AZIMUTHS_DEG.map((az) => scale(radial(az), baseRadius)) as [Vec3, Vec3, Vec3];
  const elbows = ARM_AZIMUTHS_DEG.map((az, i) => {
    const theta = conventionalAngles[i]! * DEG;
    const u = radial(az);
    return add(shoulders[i]!, [
      upperArmLength * Math.cos(theta) * u[0],
      upperArmLength * Math.cos(theta) * u[1],
      -upperArmLength * Math.sin(theta),
    ]);
  }) as [Vec3, Vec3, Vec3];

  // Effector centre P satisfies |P - (E_i - re·u_i)| = L2 for all arms: intersect three equal spheres.
  const centres = ARM_AZIMUTHS_DEG.map((az, i) => sub(elbows[i]!, scale(radial(az), effectorRadius))) as [
    Vec3,
    Vec3,
    Vec3,
  ];
  const effector = intersectSpheres(centres, lowerArmLength);
  const effectorJoints = effector ? ARM_AZIMUTHS_DEG.map((az) => add(effector, scale(radial(az), effectorRadius))) : [];
  return { shoulders, elbows, effectorJoints, effector };
}

/** Lower of the two intersection points of three spheres with equal radius, or null. */
function intersectSpheres([p1, p2, p3]: [Vec3, Vec3, Vec3], r: number): Vec3 | null {
  const d12 = sub(p2, p1);
  const d = norm(d12);
  if (d === 0) return null;
  const ex = scale(d12, 1 / d);
  const d13 = sub(p3, p1);
  const i = dot(ex, d13);
  const eyRaw = sub(d13, scale(ex, i));
  const eyNorm = norm(eyRaw);
  if (eyNorm === 0) return null;
  const ey = scale(eyRaw, 1 / eyNorm);
  let ez = cross(ex, ey);
  const j = dot(ey, d13);
  const x = d / 2;
  const y = (i * i + j * j) / (2 * j) - (i / j) * x;
  const z2 = r * r - x * x - y * y;
  if (z2 < -1e-9) return null;
  const z = Math.sqrt(Math.max(0, z2));
  if (ez[2] > 0) ez = scale(ez, -1);
  return add(add(add(p1, scale(ex, x)), scale(ey, y)), scale(ez, z));
}

/**
 * Inverse kinematics: conventional upper-arm angles (degrees) placing the effector centre at `effector`.
 * Picks the elbow-out solution. Returns null if the point is not reachable.
 */
export function deltaInverse(geometry: DeltaGeometry, effector: Vec3): [number, number, number] | null {
  const { baseRadius, effectorRadius, upperArmLength: l1, lowerArmLength: l2 } = geometry;
  const angles: number[] = [];
  for (const az of ARM_AZIMUTHS_DEG) {
    // Rotate the target into the arm's plane (arm along +X).
    const c = Math.cos(-az * DEG);
    const s = Math.sin(-az * DEG);
    const jx = c * effector[0] - s * effector[1] + effectorRadius;
    const jy = s * effector[0] + c * effector[1];
    const jz = effector[2];
    const a = jx - baseRadius;
    const b = jz;
    const k = (l2 * l2 - jy * jy - l1 * l1 - a * a - b * b) / (2 * l1);
    const rr = Math.sqrt(a * a + b * b);
    if (rr === 0 || Math.abs(k / rr) > 1) return null;
    // b·sinθ − a·cosθ = k  ⇔  rr·sin(θ − δ) = k with δ = atan2(a, b)
    const delta = Math.atan2(a, b);
    const asinK = Math.asin(k / rr);
    const t1 = delta + asinK;
    const t2 = delta + Math.PI - asinK;
    const theta = Math.cos(t1) >= Math.cos(t2) ? t1 : t2;
    angles.push(normaliseDeg(theta / DEG));
  }
  return angles as [number, number, number];
}

function normaliseDeg(angle: number): number {
  let a = angle % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}
