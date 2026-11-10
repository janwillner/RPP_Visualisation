import * as THREE from "three";
import type { Draft } from "@rpp/protocol";
import { useThree } from "@react-three/fiber";
import { type MutableRefObject, useEffect, useMemo, useRef } from "react";
import { OVERLAY } from "../palette";
import { pickOnScreen, type Projection } from "../scene/picking";
import { mcsToRenderer, rendererToMcs, type MachineScene } from "../scene/scene-model";
import type { Configurator } from "./configurator";
import { keyOf } from "./edits";

/**
 * Finds the point of the horizontal plane at `heightMm` (MCS Z) under a client position, MCS mm; undefined when the
 * plane is not there (looking above the horizon).
 */
export type FloorPicker = (clientX: number, clientY: number, heightMm: number) => { x: number; y: number } | undefined;

/** Radius of the move handle, metres. */
const HANDLE_RADIUS = 0.12;

interface EditControlsProps {
  configurator: Configurator;
  /** The draft shown, so the handle follows the selected component. */
  draft: Draft;
  /** The selected component's key. */
  selection: string | undefined;
  /** The machine scene of the last frame: its snap points catch a dragged component. */
  modelRef: MutableRefObject<MachineScene | undefined>;
  /** Receives the floor picker, for drops from the palette. */
  floorRef: MutableRefObject<FloorPicker | undefined>;
  /** True from a press on the move handle until the tap after it has been decided. */
  pressedRef: MutableRefObject<boolean>;
}

/**
 * The configurator's controls in the 3D view: a move handle on the selected component's origin that drags it over
 * the floor (on the grid, caught by other components' snap points), and the floor picker for the palette.
 */
export function EditControls({ configurator, draft, selection, modelRef, floorRef, pressedRef }: EditControlsProps) {
  const { camera, gl, controls } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const drag = useRef<{ pointerId: number; key: string; height: number } | undefined>(undefined);
  const component = draft.components.find((c) => keyOf(c) === selection);

  /** The point of the horizontal plane at `heightMm` under a client position, MCS mm. */
  const planePoint = (clientX: number, clientY: number, heightMm: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -heightMm / 1000);
    const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return undefined;
    const [x, y] = rendererToMcs([hit.x, hit.y, hit.z]);
    return { x, y };
  };

  useEffect(() => {
    floorRef.current = planePoint;
    return () => {
      floorRef.current = undefined;
    };
  });

  useEffect(() => {
    const projection: Projection = (position) => {
      const v = new THREE.Vector3(...position).project(camera);
      if (v.z < -1 || v.z > 1) return undefined;
      const rect = gl.domElement.getBoundingClientRect();
      return {
        screen: { x: ((v.x + 1) / 2) * rect.width + rect.left, y: ((1 - v.y) / 2) * rect.height + rect.top },
        depth: camera.position.distanceTo(new THREE.Vector3(...position)),
      };
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const [sourceId, id] = [d.key.slice(0, d.key.lastIndexOf("#")), Number(d.key.slice(d.key.lastIndexOf("#") + 1))];
      // Another component's characteristic point near the pointer catches the dragged one, e.g. a belt's end.
      const others = (modelRef.current?.snapPoints ?? []).filter(
        (p) => !p.moving && !(p.sourceId === sourceId && p.local.componentId === id),
      );
      const snapped = pickOnScreen(others, { x: e.clientX, y: e.clientY }, e.pointerType, projection);
      const at = snapped ? { x: snapped.mcs[0], y: snapped.mcs[1] } : planePoint(e.clientX, e.clientY, d.height);
      if (at) configurator.moveTo(d.key, at, { onGrid: !snapped });
    };
    const onUp = (e: PointerEvent) => {
      if (!drag.current || e.pointerId !== drag.current.pointerId) return;
      drag.current = undefined;
      configurator.endGesture();
      if (controls) (controls as unknown as { enabled: boolean }).enabled = true;
      // After the 3D view has decided on the tap (its own timeout, queued first), presses count again.
      setTimeout(() => (pressedRef.current = false), 0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [camera, gl, controls, configurator, modelRef, pressedRef]);

  if (!component || !selection) return null;
  const { x, y, z } = component.pose;
  return (
    <group position={mcsToRenderer([x, y, z])} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh renderOrder={10}>
        <ringGeometry args={[HANDLE_RADIUS * 0.6, HANDLE_RADIUS, 32]} />
        <meshBasicMaterial
          color={OVERLAY.moveHandle}
          transparent
          opacity={0.85}
          depthTest={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      {/* The whole disc grabs, also the ring's hole, where the component's origin is. */}
      <mesh
        onPointerDown={(e) => {
          e.stopPropagation();
          // The camera stays where it is while a component is dragged.
          if (controls) (controls as unknown as { enabled: boolean }).enabled = false;
          drag.current = { pointerId: e.pointerId, key: selection, height: z };
          pressedRef.current = true;
          configurator.beginGesture();
        }}
      >
        <circleGeometry args={[HANDLE_RADIUS, 32]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
