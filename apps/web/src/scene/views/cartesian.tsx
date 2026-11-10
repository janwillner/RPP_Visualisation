import * as THREE from "three";
import { Html } from "@react-three/drei";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { SOLID } from "../../palette";
import type { SceneCartesian } from "../scene-model";
import type { SourceFrame } from "../scene-frame";
import type { LocalSelection } from "../SceneView";
import { applyTransform, FaultScope, noRaycast, SELECT_COLOR, SolidBox } from "./common";
import { XTS_COLORS } from "./xts";

/** The Cartesian robot's mesh: rails, bridge or beam, carriage, column and flange. */

const CARTESIAN_COLORS: Record<SceneCartesian["parts"][number]["key"], string> = {
  "rail left": SOLID.profile,
  "rail right": SOLID.profile,
  bridge: SOLID.aluDark,
  beam: SOLID.aluDark,
  carriage: SOLID.aluLight,
  column: SOLID.aluMid,
};

/**
 * Cartesian robot: rails, bridge (or a fixed beam without a Y axis), carriage and column as boxes, and a flange plate at the column's lower end (green
 * while the gripper is active and no fingers are configured).
 */
export function CartesianMesh(props: {
  robot: SceneCartesian;
  frame: SourceFrame;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { robot, frame, selected, onSelect } = props;
  const { id, name } = robot;
  const parts = useRef<(THREE.Mesh | null)[]>([]);
  const flange = useRef<THREE.Group>(null);
  const cup = useRef<THREE.MeshStandardMaterial>(null);
  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect({ kind: "component", id });
  };

  useFrame(() => {
    const live = frame.part("cartesians", id);
    if (!live) return;
    live.parts.forEach((p, i) => applyTransform(parts.current[i] ?? null, p.transform));
    if (flange.current) {
      flange.current.visible = Boolean(live.flange);
      if (live.flange) applyTransform(flange.current, live.flange);
    }
    cup.current?.color.set(live.gripperActive ? XTS_COLORS.cupActive : XTS_COLORS.cup);
  });

  // Labelled at a rail or the beam, which do not move.
  const rail = robot.parts.find((p) => p.key === "rail left") ?? robot.parts.find((p) => p.key === "beam");
  return (
    <group userData={{ label: name }}>
      <FaultScope faulted={robot.fault !== null}>
        {robot.parts.map((p, i) => (
          <SolidBox
            key={p.key}
            size={[p.size[0], p.size[2], p.size[1]]}
            ref={(o: THREE.Mesh | null) => {
              parts.current[i] = o;
            }}
            onClick={select}
          >
            {/* Renderer local axes: MCS X -> x, MCS Z -> y, MCS Y -> −z (see size). */}
            <meshStandardMaterial
              color={selected ? (p.key === "carriage" ? SELECT_COLOR : SOLID.selectedStructure) : CARTESIAN_COLORS[p.key]}
              metalness={0.25}
              roughness={0.6}
            />
          </SolidBox>
        ))}
        {rail && (
          <Html position={rail.transform.position} className="label" zIndexRange={[10, 0]}>
            {name}
          </Html>
        )}
        <group ref={flange}>
          <mesh position={[0, -0.006, 0]} raycast={noRaycast}>
            <cylinderGeometry args={[0.05, 0.05, 0.012, 24]} />
            <meshStandardMaterial ref={cup} color={XTS_COLORS.cup} />
          </mesh>
        </group>
      </FaultScope>
    </group>
  );
}
