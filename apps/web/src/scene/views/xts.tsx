/** The meshes of XTS gantries and loops: their tracks of motor modules and their movers. */
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { OVERLAY, SOLID } from "../../palette";
import { type SceneGantry, type SceneLoop, type SceneTrackModule, trackSignature } from "../scene-model";
import type { SourceFrame } from "../scene-frame";
import type { LocalSelection } from "../SceneView";
import { applyTransform, EdgeLines, FaultScope, noRaycast, placeBetween, SELECT_COLOR, SolidBox } from "./common";

export const XTS_COLORS = {
  mover: SOLID.aluLight,
  arm: SOLID.dark,
  cup: SOLID.gripper,
  cupActive: SOLID.gripperActive,
  track: SOLID.profile,
  tool: OVERLAY.xtsTool,
};

/**
 * XTS gantry: a beam of track modules lifted by the common Z axis, movers with their X arm, gripper column and
 * suction cup (green while the gripper is active, with a mark along the gripper's orientation).
 */
export function GantryMesh(props: {
  gantry: SceneGantry;
  frame: SourceFrame;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { gantry, frame, selected, onSelect } = props;
  const { id, name, moverLength, moverWidth } = gantry;
  const track = useRef<THREE.Group>(null);
  const carriages = useRef<(THREE.Object3D | null)[]>([]);
  const arms = useRef<(THREE.Mesh | null)[]>([]);
  const columns = useRef<(THREE.Mesh | null)[]>([]);
  const tips = useRef<(THREE.Group | null)[]>([]);
  const cups = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect({ kind: "component", id });
  };

  useFrame(() => {
    const g = frame.part("gantries", id);
    if (!g) return;
    applyTransform(track.current, g.track);
    gantry.movers.forEach((m, i) => {
      const live = g.movers.find((x) => x.id === m.id);
      const carriage = carriages.current[i];
      if (carriage) {
        carriage.visible = Boolean(live);
        if (live) {
          carriage.position.set(...live.carriage);
          carriage.quaternion.set(...g.track.quaternion);
        }
      }
      placeBetween(arms.current[i] ?? null, live?.carriage, live?.armEnd);
      placeBetween(columns.current[i] ?? null, live?.armEnd, live?.tip.position);
      const tip = tips.current[i];
      if (tip) {
        tip.visible = Boolean(live);
        if (live) applyTransform(tip, live.tip);
      }
      cups.current[i]?.color.set(live?.gripperActive ? XTS_COLORS.cupActive : XTS_COLORS.cup);
    });
  });

  const gantryFaulted = gantry.fault !== null;
  return (
    <group userData={{ label: name }}>
      <FaultScope faulted={gantryFaulted}>
        <group ref={track}>
          {/* The track modules form the beam above the movers. */}
          <TrackModuleMeshes modules={gantry.modules} faulted={gantryFaulted} selected={selected} onClick={select} />
          <Html position={[0, 0.16, 0]} className="label" zIndexRange={[10, 0]}>
            {name}
          </Html>
        </group>
        {gantry.movers.map((m, i) => (
          <FaultScope key={m.id} faulted={gantryFaulted || m.fault !== null}>
            <group ref={(o) => (carriages.current[i] = o)}>
              <SolidBox size={[moverWidth, 0.04, moverLength]} position={[0, -0.02, 0]} onClick={select}>
                <meshStandardMaterial color={selected ? SELECT_COLOR : XTS_COLORS.mover} metalness={0.25} roughness={0.55} />
              </SolidBox>
              <Html position={[0, -0.05, 0]} className="label" zIndexRange={[10, 0]}>
                {m.id}
              </Html>
            </group>
            <mesh ref={(o) => (arms.current[i] = o)} onClick={select}>
              <cylinderGeometry args={[0.012, 0.012, 1, 12]} />
              <meshStandardMaterial color={XTS_COLORS.arm} roughness={0.5} />
            </mesh>
            <mesh ref={(o) => (columns.current[i] = o)} onClick={select}>
              <cylinderGeometry args={[0.018, 0.018, 1, 16]} />
              <meshStandardMaterial color={XTS_COLORS.arm} roughness={0.5} />
            </mesh>
            <group ref={(o) => (tips.current[i] = o)}>
              <mesh position={[0, 0.006, 0]} raycast={noRaycast}>
                <cylinderGeometry args={[0.022, 0.016, 0.012, 20]} />
                <meshStandardMaterial ref={(mat) => (cups.current[i] = mat)} color={XTS_COLORS.cup} />
              </mesh>
            </group>
          </FaultScope>
        ))}
      </FaultScope>
    </group>
  );
}

/** Gap at each end of a track module, metres, so that the joints between modules show. */
const MODULE_JOINT = 0.0015;

/**
 * One track module's solid in its module frame (MCS axes, metres; see `SceneTrackModule`): a box for a straight
 * module, a quarter ring around the curve's centre for a curve module.
 */
function trackModuleGeometry(m: SceneTrackModule): THREE.BufferGeometry {
  const [a0, a1] = m.across;
  const [d0, d1] = m.depth;
  if (m.turn === 0) {
    const geometry = new THREE.BoxGeometry(Math.max(m.length - 2 * MODULE_JOINT, 0.001), a1 - a0, d1 - d0);
    geometry.translate(m.length / 2, (a0 + a1) / 2, (d0 + d1) / 2);
    return geometry;
  }
  // The track line runs at radius R around the centre (0, turn · R); a point `a` across it lies at R − turn · a.
  const { radius: r, turn: t } = m;
  const cy = t * r;
  const radii = [r - t * a0, r - t * a1];
  const [inner, outer] = [Math.min(...radii), Math.max(...radii)];
  const joint = MODULE_JOINT / r;
  // The module starts straight "below" (left curve) or "above" (right curve) the centre and sweeps towards +X.
  const from = -t * (Math.PI / 2) + t * joint;
  const to = from + t * (m.length / r - 2 * joint);
  const shape = new THREE.Shape();
  shape.moveTo(outer * Math.cos(from), cy + outer * Math.sin(from));
  shape.absarc(0, cy, outer, from, to, t < 0);
  shape.absarc(0, cy, inner, to, from, t > 0);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: d1 - d0, bevelEnabled: false, curveSegments: 24 });
  geometry.translate(0, 0, d0);
  return geometry;
}

function TrackModuleMesh(props: { module: SceneTrackModule; selected: boolean; onClick: (e: ThreeEvent<MouseEvent>) => void }) {
  const { module: m, selected, onClick } = props;
  const signature = trackSignature([m]);
  // Rebuilt only when the module's shape changes, not with every new scene object.
  const geometry = useMemo(() => trackModuleGeometry(m), [signature]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group position={m.transform.position} quaternion={m.transform.quaternion}>
      {/* Turns the module frame's MCS axes into the renderer's: (x, y, z) → (x, z, −y). */}
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <mesh geometry={geometry} onClick={onClick}>
          <meshStandardMaterial color={selected ? SOLID.selectedStructure : XTS_COLORS.track} metalness={0.25} roughness={0.6} />
          <EdgeLines geometry={geometry} />
        </mesh>
      </group>
    </group>
  );
}

/** The track modules of an XTS gantry or loop, inside its track group; red with their own fault or the component's. */
function TrackModuleMeshes(props: {
  modules: readonly SceneTrackModule[];
  /** The whole component is faulted. */
  faulted: boolean;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  return (
    <>
      {props.modules.map((m) => (
        <FaultScope key={m.key} faulted={props.faulted || m.fault !== null}>
          <TrackModuleMesh module={m} selected={props.selected} onClick={props.onClick} />
        </FaultScope>
      ))}
    </>
  );
}

/** XTS loop: the oval track, movers turning with the tangent, and each mover's tool point. */
export function LoopMesh(props: {
  loop: SceneLoop;
  frame: SourceFrame;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { loop, frame, selected, onSelect } = props;
  const { id, name, moverLength, moverWidth } = loop;
  const base = useRef<THREE.Group>(null);
  const movers = useRef<(THREE.Group | null)[]>([]);
  const tools = useRef<(THREE.Mesh | null)[]>([]);
  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect({ kind: "component", id });
  };

  useFrame(() => {
    const l = frame.part("loops", id);
    if (!l) return;
    applyTransform(base.current, l.base);
    loop.movers.forEach((m, i) => {
      const live = l.movers.find((x) => x.id === m.id);
      const mover = movers.current[i];
      const tool = tools.current[i];
      if (mover) {
        mover.visible = Boolean(live);
        if (live) applyTransform(mover, live.transform);
      }
      if (tool) {
        tool.visible = Boolean(live);
        if (live) tool.position.set(...live.tool);
      }
    });
  });

  const loopFaulted = loop.fault !== null;
  return (
    <group userData={{ label: name }}>
      <FaultScope faulted={loopFaulted}>
        <group ref={base}>
          <TrackModuleMeshes modules={loop.modules} faulted={loopFaulted} selected={selected} onClick={select} />
          <Html position={loop.label} className="label" zIndexRange={[10, 0]}>
            {name}
          </Html>
        </group>
        {loop.movers.map((m, i) => (
          <FaultScope key={m.id} faulted={loopFaulted || m.fault !== null}>
            <group ref={(o) => (movers.current[i] = o)}>
              {/* Outwards is the mover's local −Y (MCS −Z). */}
              <SolidBox size={[moverLength, 0.04, moverWidth]} position={[0, -0.03, 0]} onClick={select}>
                <meshStandardMaterial color={selected ? SELECT_COLOR : XTS_COLORS.mover} metalness={0.25} roughness={0.55} />
              </SolidBox>
              <Html position={[0, -0.07, moverWidth / 2]} className="label" zIndexRange={[10, 0]}>
                {m.id}
              </Html>
            </group>
            <mesh ref={(o) => (tools.current[i] = o)} raycast={noRaycast}>
              <sphereGeometry args={[0.008, 10, 10]} />
              <meshBasicMaterial color={XTS_COLORS.tool} toneMapped={false} />
            </mesh>
          </FaultScope>
        ))}
      </FaultScope>
    </group>
  );
}
