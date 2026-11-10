import * as THREE from "three";
import { Line } from "@react-three/drei";
import type { ThreeElements } from "@react-three/fiber";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { SOLID, STATUS } from "../../palette";
import type { Transform, Vec3 } from "../scene-model";

/** What the meshes of every kind of scene part share: solids with edge lines, the fault tint, overlays, placement. */

export const SELECT_COLOR = STATUS.select;

/** Faulted components and movers glow in this colour; a selection highlight stays visible underneath. */
export const FAULT_COLOR = STATUS.fault;

/**
 * The fine outline along the edges of a solid part; it fades with its source like everything else. With `color`, it is
 * the whole drawing of an outline-only object (a placeholder): in that colour, unlit and not tone mapped.
 */
export function EdgeLines({ geometry, color }: { geometry: THREE.BufferGeometry; color?: string }) {
  // Only edges where faces meet at a clear angle: no lines along the facets of a round part.
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry, 30), [geometry]);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <lineSegments geometry={edges} raycast={noRaycast}>
      {color ? (
        <lineBasicMaterial color={color} transparent opacity={0.9} toneMapped={false} />
      ) : (
        <lineBasicMaterial color={SOLID.edge} transparent opacity={0.55} />
      )}
    </lineSegments>
  );
}

/** A box geometry that stays the same object while its size does, for meshes with edge lines. */
export function useBox(x: number, y: number, z: number): THREE.BoxGeometry {
  const geometry = useMemo(() => new THREE.BoxGeometry(x, y, z), [x, y, z]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

/** A solid box with edge lines; `children` is its material. */
export function SolidBox(props: { size: readonly [number, number, number]; children: ReactNode } & Omit<ThreeElements["mesh"], "args" | "children">) {
  const { size, children, ...mesh } = props;
  const geometry = useBox(size[0], size[1], size[2]);
  return (
    <mesh geometry={geometry} {...mesh}>
      {children}
      <EdgeLines geometry={geometry} />
    </mesh>
  );
}

/** Share of a part's own colour left while it glows red: little, so a light part reads red, not pink. */
const FAULT_BASE_SHARE = 0.3;

/**
 * Makes a lit part glow red while `faulted`, its own colour (e.g. the selection) dimmed but still underneath; back
 * to normal when the fault is gone. Safe to call again and again, also after the colour was set anew.
 */
export function showFault(material: THREE.MeshStandardMaterial, faulted: boolean): void {
  const u = material.userData as { faultBaseColor?: number; faultDimmedColor?: number };
  if (faulted) {
    if (material.color.getHex() !== u.faultDimmedColor) {
      u.faultBaseColor = material.color.getHex();
      material.color.multiplyScalar(FAULT_BASE_SHARE);
      u.faultDimmedColor = material.color.getHex();
    }
  } else if (u.faultDimmedColor !== undefined) {
    if (material.color.getHex() === u.faultDimmedColor) material.color.setHex(u.faultBaseColor!);
    u.faultDimmedColor = undefined;
  }
  material.emissive.set(faulted ? FAULT_COLOR : "#000000");
  material.emissiveIntensity = faulted ? 0.9 : 1;
}

/**
 * Tints every standard material below `root` red while `faulted`, except inside nested fault scopes, which tint
 * themselves (a faulted mover inside a gantry without fault).
 */
function tint(root: THREE.Object3D | null, faulted: boolean): void {
  if (!root) return;
  const visit = (o: THREE.Object3D) => {
    const material = (o as THREE.Mesh).material;
    if (material instanceof THREE.MeshStandardMaterial) showFault(material, faulted);
    for (const c of o.children) if (!c.userData.faultScope) visit(c);
  };
  visit(root);
}

/** A group whose content is tinted red while `faulted`. Re-applied on every render, so new meshes are covered. */
export function FaultScope({ faulted, children }: { faulted: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => tint(ref.current, faulted));
  return (
    <group ref={ref} userData={{ faultScope: true }}>
      {children}
    </group>
  );
}

export function applyTransform(object: THREE.Object3D | null, t: Transform | undefined): void {
  if (!object || !t) return;
  object.position.set(...t.position);
  object.quaternion.set(...t.quaternion);
}

const UP = new THREE.Vector3(0, 1, 0);

/** Objects that should never be picked (transparent volumes, markers). */
export const noRaycast = () => null;

/** Orient a unit-height cylinder mesh between two points. */
export function placeBetween(mesh: THREE.Object3D | null, a: Vec3 | undefined, b: Vec3 | undefined): void {
  if (!mesh || !a || !b) {
    if (mesh) mesh.visible = false;
    return;
  }
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const length = dir.length();
  mesh.visible = length > 0;
  if (length === 0) return;
  mesh.position.copy(va).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  mesh.scale.set(1, length, 1);
}

/** Overlays are drawn after the solid parts: transparent areas on a belt then never flicker against it. */
export const OVERLAY_ORDER = 1;

/**
 * The see-through fill of an overlay: unlit and not tone mapped, so it keeps its palette colour however the scene
 * is lit, and casts no shadow (only lit parts do).
 */
export function OverlayMaterial({ color, opacity, doubleSided }: { color: string; opacity: number; doubleSided?: boolean }) {
  return (
    <meshBasicMaterial
      color={color}
      transparent
      opacity={opacity}
      side={doubleSided ? THREE.DoubleSide : THREE.FrontSide}
      depthWrite={false}
      toneMapped={false}
    />
  );
}

/** The solid border of an overlay along `points`, so the area stays clear in front of any background. */
export function Outline({ points, color }: { points: Vec3[]; color: string }) {
  return (
    <Line points={points} color={color} lineWidth={1.5} toneMapped={false} renderOrder={OVERLAY_ORDER} raycast={noRaycast} />
  );
}

/** A closed rectangle lying `height` above the local x-z plane, centred on the origin. */
export function rectangle(length: number, width: number, height: number): Vec3[] {
  const x = length / 2;
  const z = width / 2;
  return [
    [-x, height, -z],
    [x, height, -z],
    [x, height, z],
    [-x, height, z],
    [-x, height, -z],
  ];
}

/** A closed circle of `radius` at `height` in the local x-z plane. */
export function circle(radius: number, height: number, segments = 64): Vec3[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return [Math.cos(a) * radius, height, Math.sin(a) * radius];
  });
}
