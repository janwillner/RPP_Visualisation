import * as THREE from "three";
import type { ComponentConfig, ConveyorConfig, Draft } from "@rpp/protocol";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import { type MutableRefObject, useEffect, useMemo, useRef } from "react";
import {
  componentKey,
  type MachineScene,
  mcsToRenderer,
  OVERLAY,
  pickOnScreen,
  type Projection,
  rendererToMcs,
  type Vec3,
  zoneSides,
} from "@rpp/machine-view";
import { beltToMcs } from "./belt-coordinates";
import type { Configurator, ZoneEdge } from "./configurator";
import { keyOf } from "./edits";

/**
 * Finds the point of the horizontal plane at `heightMm` (MCS Z) under a client position, MCS mm; undefined when the
 * plane is not there (looking above the horizon).
 */
export type FloorPicker = (clientX: number, clientY: number, heightMm: number) => { x: number; y: number } | undefined;

/** Radius of the move handle, metres. */
const MOVE_RADIUS = 0.12;
/** Radius of a zone's handles, metres. */
const ZONE_HANDLE_RADIUS = 0.045;

interface EditControlsProps {
  configurator: Configurator;
  /** The draft shown, so the handles follow the selected component. */
  draft: Draft;
  /** The selected component's key. */
  selection: string | undefined;
  /** The machine scene of the last frame: its snap points catch a dragged component. */
  modelRef: MutableRefObject<MachineScene | undefined>;
  /** Receives the floor picker, for drops from the palette. */
  floorRef: MutableRefObject<FloorPicker | undefined>;
  /** True from a press on a handle until the tap after it has been decided. */
  pressedRef: MutableRefObject<boolean>;
}

/** A handle being dragged: the plane it moves in and what a new point does. */
interface Drag {
  pointerId: number;
  /** MCS Z of the horizontal plane the pointer is followed in, mm. */
  height: number;
  /** For the move handle: the component that is dragged, which other components' snap points catch. */
  snapsFor?: { sourceId: string; id: number };
  apply: (at: { x: number; y: number }, snapped: boolean) => void;
}

/**
 * The configurator's controls in the 3D view, drawn as overlay by the configurator itself (ADR 0016): a move handle on
 * the selected component's origin that drags it over the floor (on the grid, caught by other components' snap
 * points), handles on its zones (start, end, CCS, both sides), and the floor picker for the palette.
 */
export function EditControls({ configurator, draft, selection, modelRef, floorRef, pressedRef }: EditControlsProps) {
  const { camera, gl, controls } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const drag = useRef<Drag | undefined>(undefined);
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
      // Another component's characteristic point near the pointer catches a dragged component, e.g. a belt's end.
      const own = d.snapsFor;
      const snapped = own
        ? pickOnScreen(
            (modelRef.current?.snapPoints ?? []).filter(
              (p) => !p.moving && !(p.sourceId === own.sourceId && p.local.componentId === own.id),
            ),
            { x: e.clientX, y: e.clientY },
            e.pointerType,
            projection,
          )
        : undefined;
      const at = snapped ? { x: snapped.mcs[0], y: snapped.mcs[1] } : planePoint(e.clientX, e.clientY, d.height);
      if (at) d.apply(at, snapped !== undefined);
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

  /** Starts dragging a handle: the camera stays where it is, and the whole drag is one step for undo. */
  const grab = (e: ThreeEvent<PointerEvent>, d: Omit<Drag, "pointerId">) => {
    e.stopPropagation();
    if (controls) (controls as unknown as { enabled: boolean }).enabled = false;
    drag.current = { pointerId: e.pointerId, ...d };
    pressedRef.current = true;
    configurator.beginGesture();
  };

  if (!component || !selection) return null;
  const { x, y, z } = component.pose;
  return (
    <>
      <Handle
        position={[x, y, z]}
        radius={MOVE_RADIUS}
        color={OVERLAY.moveHandle}
        ring
        onGrab={(e) =>
          grab(e, {
            height: z,
            snapsFor: { sourceId: component.sourceId, id: component.id },
            apply: (at, snapped) => configurator.moveTo(selection, at, { onGrid: !snapped }),
          })
        }
      />
      {zoneHandles(component, draft).map((h) => (
        <Handle
          key={`${h.index}:${h.edge}`}
          position={h.position}
          radius={ZONE_HANDLE_RADIUS}
          color={h.edge === "ccs" ? OVERLAY.ccs : OVERLAY.zone}
          onGrab={(e) =>
            grab(e, { height: h.position[2], apply: (at) => configurator.dragZone(selection, h.index, h.edge, { ...at, z: h.position[2] }) })
          }
        />
      ))}
    </>
  );
}

/** A flat disc (or ring) lying on the horizontal plane at an MCS point, grabbed anywhere on its disc. */
function Handle(props: {
  position: Vec3;
  radius: number;
  color: string;
  ring?: boolean;
  onGrab: (e: ThreeEvent<PointerEvent>) => void;
}) {
  return (
    <group position={mcsToRenderer(props.position)} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh renderOrder={10}>
        {props.ring ? (
          <ringGeometry args={[props.radius * 0.6, props.radius, 32]} />
        ) : (
          <circleGeometry args={[props.radius, 24]} />
        )}
        <meshBasicMaterial color={props.color} transparent opacity={0.9} depthTest={false} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      {/* The whole disc grabs, also a ring's hole, where the component's origin is. */}
      <mesh onPointerDown={props.onGrab}>
        <circleGeometry args={[props.radius, 24]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/**
 * Where the handles of a component's zones lie, MCS mm: start and end on the lane's centre line, the CCS at the lane's
 * left end of the CCS line, the two sides in the middle of the zone.
 */
function zoneHandles(c: ComponentConfig, draft: Draft): { index: number; edge: ZoneEdge; position: Vec3 }[] {
  if (!("zones" in c)) return [];
  const conveyors = new Map<string, ConveyorConfig>();
  for (const d of draft.components) if (d.type === "conveyor") conveyors.set(keyOf(d), d);
  return c.zones.flatMap((zone, index) => {
    const belt = conveyors.get(componentKey(c.sourceId, zone.conveyorId));
    if (!belt) return [];
    const lane = zoneSides(zone, belt);
    const centre = (lane.left + lane.right) / 2;
    const middle = (zone.start + zone.end) / 2;
    const at = (edge: ZoneEdge, bx: number, by: number) => ({ index, edge, position: beltToMcs(belt, bx, by) });
    return [
      at("start", zone.start, centre),
      at("end", zone.end, centre),
      at("ccs", zone.ccsOffset, lane.left),
      at("left", middle, lane.left),
      at("right", middle, lane.right),
    ];
  });
}
