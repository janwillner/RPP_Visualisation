import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { OVERLAY, SOLID } from "../../palette";
import type { SceneBody } from "../scene-model";
import type { SourceFrame } from "../scene-frame";
import type { LocalSelection } from "../SceneView";
import { applyTransform, EdgeLines, FaultScope, noRaycast, OVERLAY_ORDER, SELECT_COLOR } from "./common";
import { ROUND_SEGMENTS } from "./conveyor";

/** The mesh of one body of a component drawn from its bodies (ADR 0007). */

/**
 * A body's solid standing on its bottom centre, local +Y up, +X along its length, +Z across (metres): a box, an
 * (oval) cylinder whose length and width are its diameters, or a rectangular frustum.
 */
function bodyGeometry(b: SceneBody): THREE.BufferGeometry {
  const { length, width, height } = b.size;
  if (b.shape === "frustum") {
    const [x0, z0, x1, z1] = [length / 2, width / 2, b.top.length / 2, b.top.width / 2];
    // Bottom corners 0–3, top corners 4–7, counter-clockwise seen from above.
    const corners = [
      [-x0, 0, z0], [x0, 0, z0], [x0, 0, -z0], [-x0, 0, -z0],
      [-x1, height, z1], [x1, height, z1], [x1, height, -z1], [-x1, height, -z1],
    ];
    const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    const positions = faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d].flatMap((i) => corners[i!]!));
    const frustum = new THREE.BufferGeometry();
    frustum.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    frustum.computeVertexNormals();
    return frustum;
  }
  const solid =
    b.shape === "cylinder" ? new THREE.CylinderGeometry(0.5, 0.5, height, ROUND_SEGMENTS) : new THREE.BoxGeometry(1, height, 1);
  solid.scale(length, 1, width);
  solid.translate(0, height / 2, 0);
  return solid;
}

const BODY_COLORS = { structure: SOLID.profile, sensor: SOLID.sensor, beam: OVERLAY.beam, fieldOfView: OVERLAY.fieldOfView };

/**
 * One body a component is drawn from (`role` sets the look): a machine part (structure, sensor head) lit with edge
 * lines, in the active colour while active (e.g. a pusher at work) and red while its component is faulted; or an
 * overlay (beam, field of view) on the zones layer, unlit and see-through, lighting up while active. Only machine parts select their component: an overlay would cover
 * the products inside it.
 */
export function BodyMesh(props: {
  body: SceneBody;
  frame: SourceFrame;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { body, frame, selected, onSelect } = props;
  const overlay = body.role === "beam" || body.role === "fieldOfView";
  const fill = useRef<THREE.MeshBasicMaterial>(null);
  const solid = useRef<THREE.MeshStandardMaterial>(null);
  const { shape, size, top } = body;
  const geometry = useMemo(
    () => bodyGeometry(body),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shape, size.length, size.width, size.height, top.length, top.width],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(() => {
    const active = frame.part("bodies", body.key)?.active ?? false;
    if (fill.current) fill.current.opacity = active ? 0.55 : body.role === "beam" ? 0.25 : 0.08;
    // A faulted part keeps its red tint, a selected one the selection colour.
    if (solid.current && !body.faulted && !selected) solid.current.color.set(active ? SOLID.bodyActive : BODY_COLORS[body.role]);
  });
  const color = selected ? SELECT_COLOR : BODY_COLORS[body.role];
  return (
    <group ref={(o) => applyTransform(o, body.transform)}>
      {overlay ? (
        <mesh geometry={geometry} renderOrder={OVERLAY_ORDER} raycast={noRaycast}>
          <meshBasicMaterial ref={fill} color={color} transparent opacity={0.08} depthWrite={false} toneMapped={false} />
          <EdgeLines geometry={geometry} color={color} />
        </mesh>
      ) : (
        <FaultScope faulted={body.faulted}>
          <mesh
            geometry={geometry}
            userData={{ label: `#${body.componentId}` }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect({ kind: "component", id: body.componentId });
            }}
          >
            <meshStandardMaterial ref={solid} color={color} roughness={0.6} />
            <EdgeLines geometry={geometry} />
          </mesh>
        </FaultScope>
      )}
    </group>
  );
}
