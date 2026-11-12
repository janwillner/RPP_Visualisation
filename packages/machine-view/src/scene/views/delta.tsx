/** The Delta robot's meshes: base, arms, effector plate, TCP triad, and its working area. */
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { AXES, OVERLAY, SOLID } from "../../palette";
import type { SceneDelta, SceneWorkingArea, Vec3 } from "../scene-model";
import type { SourceFrame } from "../scene-frame";
import type { LocalSelection } from "../SceneView";
import {
  applyTransform,
  circle,
  EdgeLines,
  FaultScope,
  noRaycast,
  Outline,
  OVERLAY_ORDER,
  OverlayMaterial,
  placeBetween,
  SELECT_COLOR,
  SolidBox,
} from "./common";

/** A Delta working area: see-through cylinder (and cone below it) with solid rims. */
export function WorkingAreaMesh({ area: w, color }: { area: SceneWorkingArea; color: string }) {
  const rims = [circle(w.radius, w.zMax), circle(w.radius, w.zMin)];
  if (w.coneHeight > 0) rims.push(circle(w.coneBottomRadius, w.zMin - w.coneHeight));
  return (
    <group ref={(o) => applyTransform(o, w.transform)}>
      <mesh position={[0, (w.zMin + w.zMax) / 2, 0]} raycast={noRaycast} renderOrder={OVERLAY_ORDER}>
        <cylinderGeometry args={[w.radius, w.radius, w.zMax - w.zMin, 48, 1, true]} />
        <OverlayMaterial color={color} opacity={0.1} doubleSided />
      </mesh>
      {w.coneHeight > 0 && (
        <mesh position={[0, w.zMin - w.coneHeight / 2, 0]} raycast={noRaycast} renderOrder={OVERLAY_ORDER}>
          <cylinderGeometry args={[w.radius, w.coneBottomRadius, w.coneHeight, 48, 1, true]} />
          <OverlayMaterial color={color} opacity={0.1} doubleSided />
        </mesh>
      )}
      {rims.map((points, i) => (
        <Outline key={i} points={points} color={color} />
      ))}
    </group>
  );
}

const ARM_AZIMUTHS = [0, 120, 240].map((deg) => (deg * Math.PI) / 180);
const DELTA_COLORS = {
  plate: SOLID.aluLight,
  arm: SOLID.dark,
  motor: SOLID.motor,
  gearbox: SOLID.aluDark,
  rod: SOLID.dark,
  joint: SOLID.aluLight,
  effector: SOLID.aluLight,
};
/** Half the spacing between the two rods of a lower-arm parallelogram, metres. */
const ROD_HALF_SPACING = 0.035;
const MOTOR_SIZE = [0.06, 0.11, 0.06] as const;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Plate outline in the base's local MCS plane (x, y), metres: a triangle whose edge midpoints carry the
 * shoulders (inradius = baseRadius), with its corners cut off.
 */
function basePlateShape(baseRadius: number): THREE.Shape {
  const corners = [60, 180, 300].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return new THREE.Vector2(Math.cos(a), Math.sin(a)).multiplyScalar(baseRadius * 2);
  });
  const points: THREE.Vector2[] = [];
  corners.forEach((c, i) => {
    const prev = corners[(i + 2) % 3]!;
    const next = corners[(i + 1) % 3]!;
    points.push(c.clone().lerp(prev, 0.22), c.clone().lerp(next, 0.22));
  });
  return new THREE.Shape(points);
}

/**
 * Effector plate outline in the effector's local MCS plane (x, y), metres: a hexagon whose six corners are the
 * centres of the lower arms' ball joints (two per arm, `ROD_HALF_SPACING` either side of the arm's joint point at
 * `radius`), so the plate ends exactly in the ball heads.
 */
function effectorPlateShape(radius: number): THREE.Shape {
  const corners = ARM_AZIMUTHS.flatMap((a) => {
    const joint = new THREE.Vector2(Math.cos(a), Math.sin(a)).multiplyScalar(radius);
    const along = new THREE.Vector2(-Math.sin(a), Math.cos(a)).multiplyScalar(ROD_HALF_SPACING);
    return [joint.clone().sub(along), joint.clone().add(along)];
  });
  return new THREE.Shape(corners);
}

/** Small arrow along +Y of its own frame, for the TCP axis triad. */
function TriadArrow({ color, quaternion }: { color: string; quaternion: THREE.Quaternion }) {
  return (
    <group quaternion={quaternion}>
      <mesh position={[0, 0.04, 0]} raycast={noRaycast}>
        <cylinderGeometry args={[0.003, 0.003, 0.08, 8]} />
        <meshBasicMaterial color={color} depthTest={false} transparent toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.088, 0]} raycast={noRaycast}>
        <coneGeometry args={[0.008, 0.018, 12]} />
        <meshBasicMaterial color={color} depthTest={false} transparent toneMapped={false} />
      </mesh>
    </group>
  );
}

// Triad along the MCS axes (renderer frame): MCS X -> +X, MCS Y -> -Z, MCS Z -> +Y.
const TRIAD = [
  { color: AXES.x, quaternion: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(1, 0, 0)) },
  { color: AXES.y, quaternion: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(0, 0, -1)) },
  { color: AXES.z, quaternion: new THREE.Quaternion() },
];

export function DeltaMesh(props: {
  delta: SceneDelta;
  frame: SourceFrame;
  showTcp: boolean;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { delta, frame, showTcp, selected, onSelect } = props;
  const { id, name, baseRadius, effectorRadius } = delta;
  const base = useRef<THREE.Group>(null);
  const effector = useRef<THREE.Group>(null);
  const upper = useRef<(THREE.Mesh | null)[]>([]);
  /** Per arm: elbow bar, effector bar, two rods, four ball joints. */
  const lower = useRef<(THREE.Object3D | null)[][]>([[], [], []]);
  const setpoint = useRef<THREE.Mesh>(null);
  /** Axis triad at the actual TCP, unturned: the TCP is reported in the MCS. */
  const triad = useRef<THREE.Group>(null);

  // Static parts in the base's local frame (renderer axes: MCS local Y is local -Z).
  const parts = useMemo(() => {
    const plate = new THREE.ExtrudeGeometry(basePlateShape(baseRadius), { depth: 0.02, bevelEnabled: false });
    plate.rotateX(-Math.PI / 2);
    const effectorPlate = new THREE.ExtrudeGeometry(effectorPlateShape(effectorRadius), {
      depth: 0.012,
      bevelEnabled: false,
    });
    effectorPlate.rotateX(-Math.PI / 2);
    effectorPlate.translate(0, -0.006, 0);
    const motors = ARM_AZIMUTHS.map((a) => {
      const radial = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
      const tangent = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a));
      const shoulder = radial.clone().multiplyScalar(baseRadius);
      return {
        quaternion: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, tangent),
        gearbox: shoulder.clone().addScaledVector(tangent, 0.05),
        motor: shoulder.clone().addScaledVector(tangent, 0.13),
        hub: shoulder,
      };
    });
    return { plate, effectorPlate, motors };
  }, [baseRadius, effectorRadius]);

  useFrame(() => {
    const d = frame.part("deltas", id);
    if (!d) return;
    applyTransform(base.current, d.base);
    if (effector.current) {
      effector.current.visible = d.effector !== null;
      applyTransform(effector.current, d.effector ?? undefined);
    }
    const baseCentre = new THREE.Vector3(...d.base.position);
    const baseUp = Y_AXIS.clone().applyQuaternion(new THREE.Quaternion(...d.base.quaternion));
    for (let i = 0; i < 3; i++) {
      placeBetween(upper.current[i] ?? null, d.shoulders[i], d.elbows[i]);
      const [elbowBar, effectorBar, rodA, rodB, ...balls] = lower.current[i] ?? [];
      const elbow = d.elbows[i];
      const joint = d.effectorJoints[i];
      const shoulder = d.shoulders[i];
      const visible = Boolean(elbow && joint && shoulder);
      for (const o of [elbowBar, effectorBar, rodA, rodB, ...balls]) if (o) o.visible = visible;
      if (!visible) continue;
      // The parallelogram's rods are offset along the shoulder axis (tangential to the base).
      const radial = new THREE.Vector3(...shoulder!).sub(baseCentre);
      const offset = new THREE.Vector3().crossVectors(baseUp, radial).normalize().multiplyScalar(ROD_HALF_SPACING);
      const e = new THREE.Vector3(...elbow!);
      const j = new THREE.Vector3(...joint!);
      const ends = [e.clone().add(offset), e.clone().sub(offset), j.clone().add(offset), j.clone().sub(offset)];
      const v = (p: THREE.Vector3) => p.toArray() as Vec3;
      placeBetween(elbowBar ?? null, v(ends[0]!), v(ends[1]!));
      placeBetween(effectorBar ?? null, v(ends[2]!), v(ends[3]!));
      placeBetween(rodA ?? null, v(ends[0]!), v(ends[2]!));
      placeBetween(rodB ?? null, v(ends[1]!), v(ends[3]!));
      balls.forEach((b, k) => b?.position.copy(ends[k]!));
    }
    if (triad.current) {
      triad.current.visible = showTcp && d.actualTcp !== null;
      if (d.actualTcp) triad.current.position.set(...d.actualTcp);
    }
    if (setpoint.current) {
      setpoint.current.visible = showTcp && d.setpointTcp !== null;
      if (d.setpointTcp) setpoint.current.position.set(...d.setpointTcp);
    }
  });

  const highlight = selected ? SELECT_COLOR : undefined;
  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect({ kind: "component", id });
  };
  const setLower = (arm: number, slot: number) => (o: THREE.Object3D | null) => {
    lower.current[arm]![slot] = o;
  };
  return (
    <group userData={{ label: name }}>
      <FaultScope faulted={delta.fault !== null}>
        <group ref={base}>
          <mesh geometry={parts.plate} onClick={select}>
            <meshStandardMaterial color={highlight ?? DELTA_COLORS.plate} metalness={0.2} roughness={0.65} />
            <EdgeLines geometry={parts.plate} />
          </mesh>
          {parts.motors.map((m, i) => (
            <group key={i}>
              <mesh position={m.hub} quaternion={m.quaternion} onClick={select}>
                <cylinderGeometry args={[0.035, 0.035, 0.05, 20]} />
                <meshStandardMaterial color={DELTA_COLORS.gearbox} metalness={0.3} roughness={0.55} />
              </mesh>
              <mesh position={m.gearbox} quaternion={m.quaternion} onClick={select}>
                <cylinderGeometry args={[0.03, 0.03, 0.05, 20]} />
                <meshStandardMaterial color={DELTA_COLORS.gearbox} metalness={0.3} roughness={0.55} />
              </mesh>
              <SolidBox size={MOTOR_SIZE} position={m.motor} quaternion={m.quaternion} onClick={select}>
                <meshStandardMaterial color={DELTA_COLORS.motor} roughness={0.7} />
              </SolidBox>
            </group>
          ))}
          <Html position={[0, 0.1, 0]} className="label" zIndexRange={[10, 0]}>
            {name}
          </Html>
        </group>
        {[0, 1, 2].map((i) => (
          <group key={i}>
            <mesh ref={(m) => (upper.current[i] = m)} onClick={select}>
              <cylinderGeometry args={[0.022, 0.022, 1, 16]} />
              <meshStandardMaterial color={highlight ?? DELTA_COLORS.arm} roughness={0.5} />
            </mesh>
            {[0, 1].map((k) => (
              <mesh key={"bar" + k} ref={setLower(i, k)} onClick={select}>
                <cylinderGeometry args={[0.006, 0.006, 1, 8]} />
                <meshStandardMaterial color={DELTA_COLORS.joint} metalness={0.35} roughness={0.5} />
              </mesh>
            ))}
            {[2, 3].map((k) => (
              <mesh key={"rod" + k} ref={setLower(i, k)} onClick={select}>
                <cylinderGeometry args={[0.006, 0.006, 1, 8]} />
                <meshStandardMaterial color={highlight ?? DELTA_COLORS.rod} roughness={0.5} />
              </mesh>
            ))}
            {[4, 5, 6, 7].map((k) => (
              <mesh key={"ball" + k} ref={setLower(i, k)} raycast={noRaycast}>
                <sphereGeometry args={[0.011, 12, 12]} />
                <meshStandardMaterial color={DELTA_COLORS.joint} metalness={0.35} roughness={0.5} />
              </mesh>
            ))}
          </group>
        ))}
        <group ref={effector} userData={{ label: name + " TCP" }}>
          <mesh geometry={parts.effectorPlate} onClick={select}>
            <meshStandardMaterial color={DELTA_COLORS.effector} metalness={0.3} roughness={0.5} />
            <EdgeLines geometry={parts.effectorPlate} />
          </mesh>
        </group>
        <group ref={triad} userData={{ label: name + " TCP axes" }}>
          {TRIAD.map((t) => (
            <TriadArrow key={t.color} color={t.color} quaternion={t.quaternion} />
          ))}
        </group>
        <mesh ref={setpoint} userData={{ label: name + " setpoint TCP" }}>
          <octahedronGeometry args={[0.018]} />
          <meshBasicMaterial color={OVERLAY.setpoint} wireframe depthTest={false} transparent toneMapped={false} />
        </mesh>
      </FaultScope>
    </group>
  );
}
