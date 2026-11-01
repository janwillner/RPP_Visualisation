import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeElements, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { AXES, OVERLAY, PRODUCT, SOLID, STAGE, STATUS } from "../palette";
import { FrameRateSampler, qualityFor, type Quality, type QualitySetting } from "./quality";
import type { CameraPose } from "../view-settings";
import type { SceneFeed, SourceInfo } from "../connection";
import type {
  ProductDisplay,
  SceneAllocation,
  SceneBoxArea,
  SceneCartesian,
  SceneDelta,
  SceneFinger,
  SceneGantry,
  SceneLoop,
  SceneModel,
  SceneOrigin,
  SceneProduct,
  SceneWorkingArea,
  SceneZone,
  SnapPoint,
  Transform,
  Vec3,
  MachineScene,
  SceneConveyor,
  SceneFaultLabel,
  SourcedFaults,
} from "./scene-model";
import { availableSnapPoints, buildMachineScene } from "./scene-model";
import { isTap, nearestOnScreen, snapRadiusPx, type ScreenPoint } from "./picking";
import type { ConfigMessage, ProductState } from "@rpp/protocol";

export interface Layers {
  workingAreas: boolean;
  limitAreas: boolean;
  zones: boolean;
  tcpMarkers: boolean;
  faultLabels: boolean;
}

/**
 * A selection within one source's scene, by manifest id. A product is selected by register identity, so the
 * selection survives display changes (e.g. picked).
 */
export type LocalSelection =
  | { kind: "component"; id: number }
  | { kind: "product"; conveyorId: number; productId: number }
  | undefined;

/** A selection in the machine: manifest ids are unique only within their source. */
export type Selection = (NonNullable<LocalSelection> & { sourceId: string }) | undefined;

export type CameraPreset = "top" | "front" | "side" | "iso";

/** A measuring point: a snap point frozen at the moment it was clicked. */
export interface MeasurePoint {
  id: number;
  label: string;
  /** MCS, mm. */
  mcs: Vec3;
  /** Renderer position, metres. */
  position: Vec3;
  local: SnapPoint["local"];
}

export interface SceneViewProps {
  /** The live gateway or a recording being played back. */
  feed: SceneFeed;
  /** The PLC sources, each drawn on its own. */
  sources: SourceInfo[];
  layers: Layers;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** Changes to `{ action, seq }` move the camera; `seq` allows repeating the same action. */
  cameraRequest: { action: CameraPreset; seq: number };
  /** Where the camera starts once the machine appears; undefined frames the whole machine. */
  initialCamera?: CameraPose;
  /** Called when someone has moved the camera, by a gesture or a view button. */
  onCameraChange?: (pose: CameraPose) => void;
  /** Receives the machine scene every frame, e.g. for the inspector. */
  modelRef: MutableRefObject<MachineScene | undefined>;
  /** Measure mode: origins and snap points are shown, a click on a snap point measures instead of selecting. */
  measureMode: boolean;
  /** Called with the snap point under the pointer when it is clicked in measure mode. */
  onMeasure: (point: SnapPoint) => void;
  measurePoints: MeasurePoint[];
  /** Component keys and source ids hidden by the user. */
  hidden: ReadonlySet<string>;
  /** Render quality chosen on this device. */
  quality: QualitySetting;
  /** Called with the quality actually rendered, whenever it changes (auto may drop to low). */
  onQuality?: (quality: Quality) => void;
  /** Called whenever the set of active faults changes (hidden components included). */
  onFaults: (faults: SourcedFaults[]) => void;
}

const EMPTY: SceneModel = {
  conveyors: [],
  products: [],
  deltas: [],
  workingAreas: [],
  zones: [],
  gantries: [],
  boxAreas: [],
  limitAreas: [],
  loops: [],
  cartesians: [],
  fingers: [],
  snapPoints: [],
  origins: [],
  faultLabels: [],
  faults: [],
  warnings: [],
};


const PRODUCT_COLORS: Record<ProductState, string> = PRODUCT;
const MISSED_COLOR = STATUS.missed;
const SELECT_COLOR = STATUS.select;
/** Faulted components and movers glow in this colour; a selection highlight stays visible underneath. */
const FAULT_COLOR = STATUS.fault;

/** The fine outline along the edges of a solid part; it fades with its source like everything else. */
function EdgeLines({ geometry }: { geometry: THREE.BufferGeometry }) {
  // Only edges where faces meet at a clear angle: no lines along the facets of a round part.
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry, 30), [geometry]);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <lineSegments geometry={edges} raycast={noRaycast}>
      <lineBasicMaterial color={SOLID.edge} transparent opacity={0.55} />
    </lineSegments>
  );
}

/** A box geometry that stays the same object while its size does, for meshes with edge lines. */
function useBox(x: number, y: number, z: number): THREE.BoxGeometry {
  const geometry = useMemo(() => new THREE.BoxGeometry(x, y, z), [x, y, z]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

/** A solid box with edge lines; `children` is its material. */
function SolidBox(props: { size: readonly [number, number, number]; children: ReactNode } & Omit<ThreeElements["mesh"], "args" | "children">) {
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
function showFault(material: THREE.MeshStandardMaterial, faulted: boolean): void {
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
function FaultScope({ faulted, children }: { faulted: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => tint(ref.current, faulted));
  return (
    <group ref={ref} userData={{ faultScope: true }}>
      {children}
    </group>
  );
}

/** Opacity factor of everything a source draws while the gateway cannot read its PLC. */
const OFFLINE_OPACITY = 0.25;

/**
 * Fades every material below `root` while `offline`: the source's last known state stays visible, clearly not live.
 * The original opacity is kept on the material, so it comes back when the source is online again.
 */
function fade(root: THREE.Object3D | null, offline: boolean): void {
  root?.traverse((o) => {
    const material = (o as THREE.Mesh).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      const base = (m.userData.base ??= { opacity: m.opacity, transparent: m.transparent }) as {
        opacity: number;
        transparent: boolean;
      };
      const transparent = offline || base.transparent;
      if (m.transparent !== transparent) {
        m.transparent = transparent;
        m.needsUpdate = true;
      }
      m.opacity = offline ? base.opacity * OFFLINE_OPACITY : base.opacity;
    }
  });
}

/**
 * A group whose content is faded while `offline`, and whose lit parts cast shadows. Re-applied on every render, so
 * new meshes are covered.
 */
function OfflineScope({ offline, children }: { offline: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    fade(ref.current, offline);
    castShadows(ref.current);
  });
  return <group ref={ref}>{children}</group>;
}

/** A fault message hanging above its component or mover; follows a moving mover. */
function FaultLabel({ label, latest }: { label: SceneFaultLabel; latest: MutableRefObject<SceneModel> }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const live = latest.current.faultLabels.find((l) => l.key === label.key);
    if (live) group.current?.position.set(...live.position);
  });
  return (
    <group ref={group} position={label.position}>
      <Html center className="fault-label" zIndexRange={[25, 15]} style={{ pointerEvents: "none" }}>
        {label.message}
      </Html>
    </group>
  );
}

function applyTransform(object: THREE.Object3D | null, t: Transform | undefined): void {
  if (!object || !t) return;
  object.position.set(...t.position);
  object.quaternion.set(...t.quaternion);
}

const UP = new THREE.Vector3(0, 1, 0);

/** Objects that should never be picked (transparent volumes, markers). */
const noRaycast = () => null;

/** Orient a unit-height cylinder mesh between two points. */
function placeBetween(mesh: THREE.Object3D | null, a: Vec3 | undefined, b: Vec3 | undefined): void {
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

/** Structural signature: re-render React only when the set of drawn objects changes. */
function signature(m: SceneModel): string {
  return [
    m.conveyors.map((c) => `${c.id}:${c.length}:${c.width}`).join(","),
    m.products.map((p) => `${p.key}:${p.state}`).join(","),
    m.deltas.map((d) => d.id + ":" + d.baseRadius + ":" + d.effectorRadius).join(","),
    m.zones.map((w) => `${w.robotId}:${w.conveyorId}:${w.kind}`).join(","),
    m.snapPoints.filter((p) => !p.moving).map((p) => p.key).join(","),
    m.gantries.map((g) => `${g.id}:${g.moduleCount}:${g.moduleLength}:${g.movers.map((x) => x.id).join("/")}`).join(","),
    m.boxAreas.map((a) => `${a.robotId}:${a.size.join("/")}`).join(","),
    m.limitAreas.map((a) => `${a.robotId}:${a.size.join("/")}`).join(","),
    m.zones.map((w) => (w.allocation ? w.allocation.length : 0)).join(","),
    m.loops.map((l) => `${l.id}:${l.straightLength}:${l.curveRadius}:${l.movers.map((x) => x.id).join("/")}`).join(","),
    m.cartesians.map((c) => `${c.id}:${c.parts.map((p) => p.size.join("/")).join("/")}:${c.flange ? 1 : 0}`).join(","),
    m.fingers.map((f) => `${f.key}:${f.diameter}:${f.height}`).join(","),
    // Faults change colours and labels. Every fault of a shown component or mover has exactly one label, so the
    // labels also stand for the red tint of the parts.
    m.faultLabels.map((l) => `${l.key}:${l.message}`).join(","),
  ].join("|");
}

const EMPTY_MACHINE: MachineScene = { sources: [], snapPoints: [], origins: [], faults: [] };

/** Structural signature of what is drawn across sources: measure dots, origins, camera bounds, online state. */
function machineSignature(m: MachineScene): string {
  return [
    m.sources.map((s) => `${s.sourceId}:${s.online}:${s.scene.conveyors.length}:${s.scene.deltas.length}`).join(","),
    m.snapPoints.filter((p) => !p.moving).map((p) => p.key).join(","),
    m.origins.map((o) => `${o.sourceId}:${o.componentId}`).join(","),
  ].join("|");
}

function SceneContent(props: SceneViewProps & { renderQuality: Quality }) {
  const { feed, sources, layers, selection, modelRef, measureMode, onMeasure, measurePoints, hidden, onFaults } = props;
  // In measure mode a click measures; selecting works only through the component tree.
  const onSelect = measureMode ? () => {} : props.onSelect;
  const machine = useRef<MachineScene>(EMPTY_MACHINE);
  const [structure, setStructure] = useState<MachineScene>(EMPTY_MACHINE);
  const sig = useRef("");
  const faultSig = useRef("");

  // Priority −1: runs before the sources' frame callbacks, which read the scene built here.
  useFrame(() => {
    const model = buildMachineScene(feed.sceneSources(), hidden);
    machine.current = model;
    modelRef.current = model;
    const s = machineSignature(model);
    if (s !== sig.current) {
      sig.current = s;
      setStructure(model);
    }
    const f = JSON.stringify(model.faults);
    if (f !== faultSig.current) {
      faultSig.current = f;
      onFaults(model.faults);
    }
  }, -1);

  const bounds = useMemo(
    () => ({
      conveyors: structure.sources.flatMap((s) => s.scene.conveyors),
      deltas: structure.sources.flatMap((s) => s.scene.deltas),
    }),
    [structure],
  );

  return (
    <>
      <McsAxes />
      <MeasurePoints points={measurePoints} />
      {measureMode && <MeasureLayer latest={machine} structure={structure} layers={layers} onMeasure={onMeasure} />}
      <Stage bounds={bounds} quality={props.renderQuality} />
      {sources.map((source) => (
        <SourceContent
          key={source.sourceId}
          sourceId={source.sourceId}
          config={source.config}
          online={structure.sources.find((x) => x.sourceId === source.sourceId)?.online ?? false}
          machine={machine}
          layers={layers}
          hidden={hidden}
          selection={selection?.sourceId === source.sourceId ? selection : undefined}
          onSelect={(local) => onSelect(local && { ...local, sourceId: source.sourceId })}
        />
      ))}
      <CameraRig
        request={props.cameraRequest}
        structure={bounds}
        initial={props.initialCamera}
        onChange={props.onCameraChange}
      />
    </>
  );
}

/** Everything one PLC source draws, with its manifest ids; faded while the source is offline. */
function SourceContent(props: {
  sourceId: string;
  config: ConfigMessage | undefined;
  online: boolean;
  machine: MutableRefObject<MachineScene>;
  layers: Layers;
  hidden: ReadonlySet<string>;
  selection: LocalSelection;
  onSelect: (s: LocalSelection) => void;
}) {
  const { sourceId, config, online, machine, layers, hidden, selection, onSelect } = props;
  const latest = useRef<SceneModel>(EMPTY);
  const [structure, setStructure] = useState<SceneModel>(EMPTY);
  const sig = useRef("");
  const productIndex = useRef(new Map<string, SceneProduct>());
  // A new config can change geometry without changing ids: force a structural update.
  useEffect(() => {
    sig.current = "";
  }, [config, hidden]);

  useFrame(() => {
    const model = machine.current.sources.find((s) => s.sourceId === sourceId)?.scene ?? EMPTY;
    latest.current = model;
    productIndex.current = new Map(model.products.map((p) => [p.key, p]));
    const s = signature(model);
    if (s !== sig.current) {
      sig.current = s;
      setStructure(model);
    }
  });

  const productByKey = (key: string) => productIndex.current.get(key);
  const isSelected = (id: number) => selection?.kind === "component" && selection.id === id;

  return (
    <OfflineScope offline={!online}>
      {structure.conveyors.map((c) => (
        <group key={c.id} ref={(o) => applyTransform(o, c.transform)}>
          <FaultScope faulted={c.fault !== null}>
            <SolidBox
              size={[c.length, 0.05, c.width]}
              position={[c.length / 2, -0.025, 0]}
              userData={{ label: c.name }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect({ kind: "component", id: c.id });
              }}
            >
              <meshStandardMaterial color={isSelected(c.id) ? SOLID.selectedStructure : SOLID.belt} roughness={0.85} />
            </SolidBox>
            {/* Conveying direction */}
            <mesh position={[c.length + 0.06, 0, 0]} rotation={[0, 0, -Math.PI / 2]} raycast={noRaycast}>
              <coneGeometry args={[0.04, 0.12, 16]} />
              <meshStandardMaterial color={SOLID.beltArrow} roughness={0.6} />
            </mesh>
          </FaultScope>
          <Html position={[0, 0.06, -c.width / 2]} className="label" zIndexRange={[10, 0]}>
            {c.name}
          </Html>
        </group>
      ))}
      {structure.products.map((p) => (
        <ProductMesh
          key={p.key}
          product={p}
          selected={selection?.kind === "product" && selection.conveyorId === p.conveyorId && selection.productId === p.productId}
          lookup={productByKey}
          onSelect={onSelect}
        />
      ))}
      {structure.deltas.map((d) => (
        <DeltaMesh
          key={d.id}
          delta={d}
          latest={latest}
          showTcp={layers.tcpMarkers}
          selected={isSelected(d.id)}
          onSelect={onSelect}
        />
      ))}
      {structure.gantries.map((g) => (
        <GantryMesh key={g.id} gantry={g} latest={latest} selected={isSelected(g.id)} onSelect={onSelect} />
      ))}
      {structure.loops.map((l) => (
        <LoopMesh key={l.id} loop={l} latest={latest} selected={isSelected(l.id)} onSelect={onSelect} />
      ))}
      {structure.cartesians.map((c) => (
        <CartesianMesh key={c.id} robot={c} latest={latest} selected={isSelected(c.id)} onSelect={onSelect} />
      ))}
      {structure.fingers.map((f) => (
        <FingerMesh key={f.key} finger={f} latest={latest} selected={isSelected(f.robotId)} onSelect={onSelect} />
      ))}
      {layers.workingAreas &&
        structure.boxAreas.map((a) => (
          <BoxAreaMesh
            key={`box:${a.robotId}`}
            area={a}
            color={isSelected(a.robotId) ? SELECT_COLOR : OVERLAY.workingArea}
            fillOpacity={0.1}
          />
        ))}
      {layers.limitAreas &&
        structure.limitAreas.map((a) => (
          <BoxAreaMesh
            key={`limit:${a.robotId}`}
            area={a}
            color={isSelected(a.robotId) ? SELECT_COLOR : OVERLAY.limitArea}
            fillOpacity={0.06}
          />
        ))}
      {layers.workingAreas &&
        structure.workingAreas.map((w) => (
          <WorkingAreaMesh key={w.robotId} area={w} color={isSelected(w.robotId) ? SELECT_COLOR : OVERLAY.workingArea} />
        ))}
      {layers.zones &&
        structure.zones.map((w, i) => (
          <group key={`${w.robotId}:${i}`} ref={(o) => applyTransform(o, w.transform)}>
            <mesh
              position={[0, 0.003, 0]}
              renderOrder={OVERLAY_ORDER}
              userData={{ label: `${w.kind === "pick" ? "Pick" : "Place"} zone (robot #${w.robotId})` }}
            >
              <boxGeometry args={[w.length, 0.004, w.width]} />
              <OverlayMaterial
                color={w.kind === "pick" ? OVERLAY.pickZone : OVERLAY.placeZone}
                opacity={isSelected(w.robotId) ? 0.55 : 0.3}
              />
            </mesh>
            <Outline
              points={rectangle(w.length, w.width, 0.007)}
              color={isSelected(w.robotId) ? SELECT_COLOR : w.kind === "pick" ? OVERLAY.pickZone : OVERLAY.placeZone}
            />
            {w.allocation && (
              <AllocationMesh
                allocation={w.allocation}
                zone={w}
                color={w.kind === "pick" ? OVERLAY.pickAllocation : OVERLAY.placeAllocation}
                selected={isSelected(w.robotId)}
              />
            )}
          </group>
        ))}
      {layers.zones &&
        structure.zones.map((w, i) => <CcsLine key={`ccs:${w.robotId}:${i}`} transform={w.ccs} width={w.width} />)}
      {layers.faultLabels && structure.faultLabels.map((l) => <FaultLabel key={l.key} label={l} latest={latest} />)}
    </OfflineScope>
  );
}

/**
 * A zone's conveyor coordinate system: a black dashed line lying on the belt, across the whole zone width.
 * Renderer local axes: belt X -> x, belt Y -> −z.
 */
function CcsLine({ transform, width }: { transform: Transform; width: number }) {
  return (
    <group ref={(o) => applyTransform(o, transform)}>
      <Line
        points={[
          [0, 0.009, -width / 2],
          [0, 0.009, width / 2],
        ]}
        color={OVERLAY.ccs}
        lineWidth={2}
        dashed
        dashSize={0.03}
        gapSize={0.02}
        toneMapped={false}
        renderOrder={OVERLAY_ORDER}
        raycast={noRaycast}
      />
    </group>
  );
}

/** Overlays are drawn after the solid parts: transparent areas on a belt then never flicker against it. */
const OVERLAY_ORDER = 1;

/**
 * The see-through fill of an overlay: unlit and not tone mapped, so it keeps its palette colour however the scene
 * is lit, and casts no shadow (only lit parts do).
 */
function OverlayMaterial({ color, opacity, doubleSided }: { color: string; opacity: number; doubleSided?: boolean }) {
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
function Outline({ points, color }: { points: Vec3[]; color: string }) {
  return (
    <Line points={points} color={color} lineWidth={1.5} toneMapped={false} renderOrder={OVERLAY_ORDER} raycast={noRaycast} />
  );
}

/** A closed rectangle lying `height` above the local x-z plane, centred on the origin. */
function rectangle(length: number, width: number, height: number): Vec3[] {
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
function circle(radius: number, height: number, segments = 64): Vec3[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return [Math.cos(a) * radius, height, Math.sin(a) * radius];
  });
}

/** A box area (Cartesian working area, Delta limit area): see-through box with solid edges. */
function BoxAreaMesh({ area, color, fillOpacity }: { area: SceneBoxArea; color: string; fillOpacity: number }) {
  // Renderer local axes: MCS X -> x, MCS Z -> y, MCS Y -> −z.
  const geometry = useBox(area.size[0], area.size[2], area.size[1]);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry]);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <group ref={(o) => applyTransform(o, area.transform)}>
      <mesh geometry={geometry} raycast={noRaycast} renderOrder={OVERLAY_ORDER}>
        <OverlayMaterial color={color} opacity={fillOpacity} doubleSided />
      </mesh>
      <lineSegments geometry={edges} raycast={noRaycast} renderOrder={OVERLAY_ORDER}>
        <lineBasicMaterial color={color} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/** A Delta working area: see-through cylinder (and cone below it) with solid rims. */
function WorkingAreaMesh({ area: w, color }: { area: SceneWorkingArea; color: string }) {
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

/**
 * Allocation area inside a zone, drawn in the zone's frame: a denser strip from the zone start to the allocation
 * limit and a bar across the belt at the limit.
 */
function AllocationMesh(props: { allocation: SceneAllocation; zone: SceneZone; color: string; selected: boolean }) {
  const { allocation, zone, color, selected } = props;
  return (
    <>
      <mesh position={[allocation.centre, 0.006, 0]} raycast={noRaycast} renderOrder={OVERLAY_ORDER}>
        <boxGeometry args={[allocation.length, 0.004, zone.width]} />
        <OverlayMaterial color={color} opacity={selected ? 0.6 : 0.35} />
      </mesh>
      <mesh position={[allocation.limit, 0.008, 0]} raycast={noRaycast} renderOrder={OVERLAY_ORDER}>
        <boxGeometry args={[0.012, 0.006, zone.width]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </>
  );
}

const FINGER_COLORS = { active: SOLID.gripperActive, idle: SOLID.aluMid, rod: SOLID.dark };

/**
 * One gripper finger: a cylinder hanging from its top centre (green while it grips), and a thin rod from the gripper
 * flange to its top so it is clear which gripper it belongs to.
 */
function FingerMesh(props: {
  finger: SceneFinger;
  latest: MutableRefObject<SceneModel>;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { finger, latest, selected, onSelect } = props;
  const body = useRef<THREE.Group>(null);
  const rod = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    const live = latest.current.fingers.find((f) => f.key === finger.key);
    if (body.current) {
      body.current.visible = Boolean(live);
      if (live) applyTransform(body.current, live.transform);
    }
    placeBetween(rod.current, live?.flange, live?.transform.position);
    material.current?.color.set(selected ? SELECT_COLOR : live?.active ? FINGER_COLORS.active : FINGER_COLORS.idle);
    // Like every faulted part: glowing red, with the selection colour still underneath.
    if (material.current) showFault(material.current, Boolean(live?.faulted));
  });
  return (
    <>
      <group ref={body} userData={{ label: `Finger ${finger.index}` }}>
        {/* Renderer local −Y is the finger's MCS local −Z. */}
        <mesh
          position={[0, -finger.height / 2, 0]}
          onClick={(e) => {
            e.stopPropagation();
            onSelect({ kind: "component", id: finger.robotId });
          }}
        >
          <cylinderGeometry args={[finger.diameter / 2, finger.diameter / 2, finger.height, 20]} />
          <meshStandardMaterial ref={material} color={FINGER_COLORS.idle} metalness={0.3} roughness={0.5} />
        </mesh>
      </group>
      <mesh ref={rod} raycast={noRaycast}>
        <cylinderGeometry args={[0.004, 0.004, 1, 8]} />
        <meshStandardMaterial color={FINGER_COLORS.rod} />
      </mesh>
    </>
  );
}

function ProductMesh(props: {
  product: SceneProduct;
  selected: boolean;
  lookup: (key: string) => SceneProduct | undefined;
  onSelect: (s: LocalSelection) => void;
}) {
  const { product, selected, lookup, onSelect } = props;
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => applyTransform(ref.current, lookup(product.key)?.transform));
  const display: ProductDisplay = product.display;
  const color = selected ? SELECT_COLOR : display === "missed" ? MISSED_COLOR : PRODUCT_COLORS[product.state];
  const geometry = useBox(product.size.length, product.size.height, product.size.width);
  return (
    <mesh
      ref={(m) => {
        ref.current = m;
        applyTransform(m, product.transform);
      }}
      geometry={geometry}
      userData={{ label: `Product #${product.productId} (${product.display})` }}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onSelect({ kind: "product", conveyorId: product.conveyorId, productId: product.productId });
      }}
    >
      {display === "placeholder" ? (
        // Not yet confirmed: an outline only, unlit like the other overlays.
        <meshBasicMaterial color={color} wireframe transparent opacity={0.8} toneMapped={false} />
      ) : (
        <>
          <meshStandardMaterial
            color={color}
            emissive={display === "missed" ? MISSED_COLOR : "#000"}
            emissiveIntensity={0.4}
            roughness={0.6}
          />
          <EdgeLines geometry={geometry} />
        </>
      )}
    </mesh>
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

// Triad in the effector's local frame: MCS X -> local +X, MCS Y -> local -Z, MCS Z -> local +Y.
const TRIAD = [
  { color: AXES.x, quaternion: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(1, 0, 0)) },
  { color: AXES.y, quaternion: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(0, 0, -1)) },
  { color: AXES.z, quaternion: new THREE.Quaternion() },
];

function DeltaMesh(props: {
  delta: SceneDelta;
  latest: MutableRefObject<SceneModel>;
  showTcp: boolean;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { delta, latest, showTcp, selected, onSelect } = props;
  const { id, name, baseRadius, effectorRadius } = delta;
  const base = useRef<THREE.Group>(null);
  const effector = useRef<THREE.Group>(null);
  const upper = useRef<(THREE.Mesh | null)[]>([]);
  /** Per arm: elbow bar, effector bar, two rods, four ball joints. */
  const lower = useRef<(THREE.Object3D | null)[][]>([[], [], []]);
  const setpoint = useRef<THREE.Mesh>(null);

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
    const d = latest.current.deltas.find((x) => x.id === id);
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
          {showTcp && TRIAD.map((t) => <TriadArrow key={t.color} color={t.color} quaternion={t.quaternion} />)}
        </group>
        <mesh ref={setpoint} userData={{ label: name + " setpoint TCP" }}>
          <octahedronGeometry args={[0.018]} />
          <meshBasicMaterial color={OVERLAY.setpoint} wireframe depthTest={false} transparent toneMapped={false} />
        </mesh>
      </FaultScope>
    </group>
  );
}

/** Measuring points with their numbers, joined in order by a line. */
function MeasurePoints({ points }: { points: MeasurePoint[] }) {
  return (
    <>
      {points.length > 1 && (
        <Line points={points.map((p) => p.position)} color={SELECT_COLOR} lineWidth={1.5} depthTest={false} transparent toneMapped={false} />
      )}
      {points.map((p) => (
        <group key={p.id} position={p.position}>
          <mesh raycast={noRaycast} renderOrder={10}>
            <sphereGeometry args={[0.012, 12, 12]} />
            <meshBasicMaterial color={SELECT_COLOR} depthTest={false} transparent toneMapped={false} />
          </mesh>
          <Html className="pin-label" zIndexRange={[20, 10]} style={{ pointerEvents: "none" }}>
            #{p.id}
          </Html>
        </group>
      ))}
    </>
  );
}

/**
 * Measure mode overlay: component origins, the static snap points as dots, and the snap point nearest to the
 * pointer (within the pointer type's snap radius on screen, also when occluded) highlighted with its name.
 * - Mouse and pen: the point under the hovering pointer is highlighted; a click without camera drag measures it.
 * - Touch: there is no hover. One finger shows the point under it (its name above the finger), sliding moves the
 *   choice, lifting the finger measures it. Two fingers move the camera and measure nothing.
 */
function MeasureLayer(props: {
  latest: MutableRefObject<MachineScene>;
  structure: MachineScene;
  layers: Layers;
  onMeasure: (point: SnapPoint) => void;
}) {
  const { latest, structure, layers, onMeasure } = props;
  const { camera, gl } = useThree();
  const pointer = useRef<(ScreenPoint & { type: string }) | null>(null);
  const marker = useRef<THREE.Group>(null);
  const [label, setLabel] = useState<{ text: string; touch: boolean } | null>(null);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  /** The snap point under a screen position, for the given pointer type's snap radius. */
  const pick = (at: ScreenPoint, pointerType: string): SnapPoint | undefined => {
    const width = gl.domElement.clientWidth;
    const height = gl.domElement.clientHeight;
    const v = new THREE.Vector3();
    const candidates: { item: SnapPoint; screen: ScreenPoint; depth: number }[] = [];
    for (const point of availableSnapPoints(latest.current.snapPoints, layers)) {
      v.set(...point.position).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      candidates.push({
        item: point,
        screen: { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height },
        depth: camera.position.distanceTo(new THREE.Vector3(...point.position)),
      });
    }
    return nearestOnScreen(candidates, at, snapRadiusPx(pointerType));
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;

  useEffect(() => {
    const el = gl.domElement;
    const fingers = new Set<number>();
    let press: { start: ScreenPoint; type: string; multi: boolean } | null = null;
    const position = (e: PointerEvent): ScreenPoint => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      // A finger only points while it touches; with two fingers down the camera moves.
      if (e.pointerType === "touch" && (!fingers.has(e.pointerId) || fingers.size > 1)) return;
      pointer.current = { ...position(e), type: e.pointerType };
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "touch") pointer.current = null;
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        fingers.add(e.pointerId);
        if (fingers.size > 1) {
          if (press) press.multi = true;
          pointer.current = null;
          return;
        }
      }
      if (e.button !== 0) {
        press = null;
        return;
      }
      pointer.current = { ...position(e), type: e.pointerType };
      press = { start: position(e), type: e.pointerType, multi: false };
    };
    const onUp = (e: PointerEvent) => {
      const p = press;
      if (e.pointerType === "touch") {
        fingers.delete(e.pointerId);
        pointer.current = null;
        if (fingers.size > 0) return;
      }
      press = null;
      if (!p || p.multi) return;
      // A finger may slide to adjust its choice; a mouse drag moves the camera instead.
      const at = position(e);
      if (p.type !== "touch" && !isTap(p.start, at, p.type)) return;
      // Picked at the release position, not from the last frame: a quick tap may start and end within one frame.
      const candidate = pickRef.current(at, p.type);
      if (candidate) onMeasureRef.current(candidate);
    };
    const onCancel = (e: PointerEvent) => {
      fingers.delete(e.pointerId);
      press = null;
      if (e.pointerType === "touch") pointer.current = null;
    };
    el.style.cursor = "crosshair";
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    return () => {
      el.style.cursor = "";
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, [gl]);

  useFrame(() => {
    // Re-evaluated every frame: moving snap points pass under a still pointer.
    const p = pointer.current;
    const best = p ? pick(p, p.type) : undefined;
    if (marker.current) {
      marker.current.visible = best !== undefined;
      if (best) marker.current.position.set(...best.position);
    }
    const touch = p?.type === "touch";
    if (best?.label !== label?.text || (best && touch !== label?.touch)) {
      setLabel(best ? { text: best.label, touch } : null);
    }
  });

  const dots = availableSnapPoints(structure.snapPoints, layers).filter((p) => !p.moving);
  return (
    <>
      {structure.origins.map((o) => (
        <OriginTriad key={`${o.sourceId}:${o.componentId}`} origin={o} />
      ))}
      {dots.map((p) => (
        <mesh key={p.key} position={p.position} raycast={noRaycast} renderOrder={5}>
          <sphereGeometry args={[0.006, 10, 10]} />
          <meshBasicMaterial color={OVERLAY.snapPoint} depthTest={false} transparent opacity={0.8} toneMapped={false} />
        </mesh>
      ))}
      <group ref={marker} visible={false}>
        <mesh raycast={noRaycast} renderOrder={11}>
          <sphereGeometry args={[0.014, 14, 14]} />
          <meshBasicMaterial color={SELECT_COLOR} depthTest={false} transparent opacity={0.9} toneMapped={false} />
        </mesh>
        {label && (
          <Html
            className={label.touch ? "snap-label touch" : "snap-label"}
            zIndexRange={[30, 20]}
            style={{ pointerEvents: "none" }}
          >
            {label.text}
          </Html>
        )}
      </group>
    </>
  );
}

/** 300 mm axis triad at a component's origin (X red, Y green, Z blue), labelled with its name. */
function OriginTriad({ origin }: { origin: SceneOrigin }) {
  const axes = useMemo(
    () =>
      // Local renderer axes: MCS local X -> +X, MCS local Y -> −Z, MCS local Z -> +Y.
      (
        [
          [[1, 0, 0], AXES.x],
          [[0, 0, -1], AXES.y],
          [[0, 1, 0], AXES.z],
        ] as const
      ).map(([dir, color]) => {
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(...dir), new THREE.Vector3(), 0.3, color, 0.05, 0.025);
        arrow.traverse((o) => {
          o.renderOrder = 6;
          const material = (o as THREE.Mesh).material as THREE.Material | undefined;
          if (material) {
            material.depthTest = false;
            material.transparent = true;
            material.toneMapped = false;
          }
        });
        return arrow;
      }),
    [],
  );
  return (
    <group ref={(o) => applyTransform(o, origin.transform)}>
      {axes.map((a, i) => (
        <primitive key={i} object={a} />
      ))}
      <Html position={[0, -0.04, 0]} className="origin-label" zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        {origin.name} origin
      </Html>
    </group>
  );
}

const XTS_COLORS = {
  beam: SOLID.profile,
  module: SOLID.module,
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
function GantryMesh(props: {
  gantry: SceneGantry;
  latest: MutableRefObject<SceneModel>;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { gantry, latest, selected, onSelect } = props;
  const { id, name, trackLength, moduleLength, moduleCount, moverLength, moverWidth } = gantry;
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
    const g = latest.current.gantries.find((x) => x.id === id);
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
          {/* Beam above the movers along the track (MCS local +Y is renderer local −Z). */}
          <SolidBox size={[moverWidth + 0.04, 0.12, trackLength]} position={[0, 0.06, -trackLength / 2]} onClick={select}>
            <meshStandardMaterial color={selected ? SOLID.selectedStructure : XTS_COLORS.beam} metalness={0.25} roughness={0.6} />
          </SolidBox>
          {Array.from({ length: moduleCount + 1 }, (_, k) => (
            <mesh key={k} position={[0, 0.06, -k * moduleLength]} raycast={noRaycast}>
              <boxGeometry args={[moverWidth + 0.05, 0.125, 0.006]} />
              <meshStandardMaterial color={XTS_COLORS.module} />
            </mesh>
          ))}
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

/** Stadium-shaped band of an XTS loop in its local X-Z plane (renderer x-y), centred on the track line. */
function loopBandGeometry(length: number, radius: number, halfWidth: number, depth: number): THREE.ExtrudeGeometry {
  const path = (offset: number, shape: THREE.Path, reverse: boolean) => {
    const r = radius + offset;
    if (!reverse) {
      shape.moveTo(0, radius - r);
      shape.lineTo(length, radius - r);
      shape.absarc(length, radius, r, -Math.PI / 2, Math.PI / 2, false);
      shape.lineTo(0, radius + r);
      shape.absarc(0, radius, r, Math.PI / 2, (3 * Math.PI) / 2, false);
    } else {
      shape.moveTo(0, radius - r);
      shape.absarc(0, radius, r, (3 * Math.PI) / 2, Math.PI / 2, true);
      shape.lineTo(length, radius + r);
      shape.absarc(length, radius, r, Math.PI / 2, -Math.PI / 2, true);
      shape.lineTo(0, radius - r);
    }
  };
  const outer = new THREE.Shape();
  path(halfWidth, outer, false);
  const inner = new THREE.Path();
  path(-halfWidth, inner, true);
  outer.holes.push(inner);
  const geometry = new THREE.ExtrudeGeometry(outer, { depth, bevelEnabled: false, curveSegments: 32 });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

/** XTS loop: the oval track, movers turning with the tangent, and each mover's tool point. */
function LoopMesh(props: {
  loop: SceneLoop;
  latest: MutableRefObject<SceneModel>;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { loop, latest, selected, onSelect } = props;
  const { id, name, straightLength, curveRadius, moverLength, moverWidth } = loop;
  const base = useRef<THREE.Group>(null);
  const movers = useRef<(THREE.Group | null)[]>([]);
  const tools = useRef<(THREE.Mesh | null)[]>([]);
  const band = useMemo(
    () => loopBandGeometry(straightLength, curveRadius, 0.02, moverWidth),
    [straightLength, curveRadius, moverWidth],
  );
  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect({ kind: "component", id });
  };

  useFrame(() => {
    const l = latest.current.loops.find((x) => x.id === id);
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
          <mesh geometry={band} onClick={select}>
            <meshStandardMaterial color={selected ? SOLID.selectedStructure : XTS_COLORS.track} metalness={0.25} roughness={0.6} />
            <EdgeLines geometry={band} />
          </mesh>
          <Html position={[straightLength / 2, curveRadius, 0]} className="label" zIndexRange={[10, 0]}>
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

const CARTESIAN_COLORS: Record<SceneCartesian["parts"][number]["key"], string> = {
  "rail left": SOLID.profile,
  "rail right": SOLID.profile,
  bridge: SOLID.aluDark,
  carriage: SOLID.aluLight,
  column: SOLID.aluMid,
};

/**
 * Cartesian robot: rails, bridge, carriage and column as boxes, and a flange plate at the column's lower end (green
 * while the gripper is active and no fingers are configured).
 */
function CartesianMesh(props: {
  robot: SceneCartesian;
  latest: MutableRefObject<SceneModel>;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { robot, latest, selected, onSelect } = props;
  const { id, name } = robot;
  const parts = useRef<(THREE.Mesh | null)[]>([]);
  const flange = useRef<THREE.Group>(null);
  const cup = useRef<THREE.MeshStandardMaterial>(null);
  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect({ kind: "component", id });
  };

  useFrame(() => {
    const live = latest.current.cartesians.find((x) => x.id === id);
    if (!live) return;
    live.parts.forEach((p, i) => applyTransform(parts.current[i] ?? null, p.transform));
    if (flange.current) {
      flange.current.visible = Boolean(live.flange);
      if (live.flange) applyTransform(flange.current, live.flange);
    }
    cup.current?.color.set(live.gripperActive ? XTS_COLORS.cupActive : XTS_COLORS.cup);
  });

  // Labelled at a rail, which does not move.
  const rail = robot.parts.find((p) => p.key === "rail left");
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

/** MCS axes at the origin: X red, Y green, Z blue (Z is up). */
function McsAxes() {
  const axes = useMemo(() => {
    const make = (dir: Vec3, color: string) => {
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(...dir), new THREE.Vector3(0, 0, 0), 0.5, color, 0.08, 0.04);
      arrow.traverse((o) => {
        const material = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (material) material.toneMapped = false;
      });
      return arrow;
    };
    // MCS X -> renderer +X, MCS Y -> renderer −Z, MCS Z -> renderer +Y.
    return [make([1, 0, 0], AXES.x), make([0, 0, -1], AXES.y), make([0, 1, 0], AXES.z)];
  }, []);
  return (
    <group>
      {axes.map((a, i) => (
        <primitive key={i} object={a} />
      ))}
      <Html position={[0.56, 0, 0]} className="axis-label">X</Html>
      <Html position={[0, 0, -0.56]} className="axis-label">Y</Html>
      <Html position={[0, 0.56, 0]} className="axis-label">Z</Html>
    </group>
  );
}


/** What the camera rig needs of the OrbitControls instance. */
interface OrbitControlsLike {
  target: THREE.Vector3;
  update(): void;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}


/** The parts that give the machine its extent: conveyors and Delta bases of all sources. */
interface MachineBounds {
  conveyors: SceneConveyor[];
  deltas: SceneDelta[];
}

/** The box around the machine in renderer coordinates; a 2 m cube at the origin while nothing is known. */
function machineBox(structure: MachineBounds): THREE.Box3 {
  const box = new THREE.Box3();
  for (const c of structure.conveyors) {
    box.expandByPoint(new THREE.Vector3(...c.transform.position));
    const end = new THREE.Vector3(c.length, 0, 0).applyQuaternion(new THREE.Quaternion(...c.transform.quaternion));
    box.expandByPoint(new THREE.Vector3(...c.transform.position).add(end));
  }
  for (const d of structure.deltas) box.expandByPoint(new THREE.Vector3(...d.base.position));
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
  return box;
}
/** Quiet time after the last camera movement before it is reported as the camera's new place. */
const CAMERA_SETTLE_MS = 400;

/** Frames the conveyors and Delta bases of all sources. */
function CameraRig(props: {
  request: { action: CameraPreset; seq: number };
  structure: MachineBounds;
  initial: CameraPose | undefined;
  onChange: ((pose: CameraPose) => void) | undefined;
}) {
  const { request, structure, initial } = props;
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: OrbitControlsLike | null };
  const hasFramed = useRef(false);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Reported once the camera has come to rest (the controls glide on after a gesture), and only after the first
  // framing, so the start camera never replaces a remembered one.
  const report = () => {
    if (!hasFramed.current) return;
    clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      const target = controls?.target ?? new THREE.Vector3();
      onChange.current?.({ position: camera.position.toArray(), target: target.toArray() });
    }, CAMERA_SETTLE_MS);
  };

  useEffect(() => {
    if (!controls) return;
    controls.addEventListener("change", report);
    return () => {
      controls.removeEventListener("change", report);
      clearTimeout(pending.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls]);

  const frame = (preset: CameraPreset) => {
    const box = machineBox(structure);
    const centre = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
    const offsets: Record<CameraPreset, THREE.Vector3> = {
      top: new THREE.Vector3(0, size * 1.2, 0.001),
      // Front: looking along MCS +Y (renderer −Z), i.e. from MCS −Y.
      front: new THREE.Vector3(0, size * 0.15, size * 1.1),
      // Side: looking along MCS +X (renderer +X), i.e. from MCS −X, against the conveying direction's start.
      side: new THREE.Vector3(-size * 1.1, size * 0.15, 0),
      iso: new THREE.Vector3(size * 0.7, size * 0.7, size * 0.7),
    };
    camera.position.copy(centre).add(offsets[preset]);
    camera.lookAt(centre);
    if (controls) {
      controls.target.copy(centre);
      controls.update();
    }
  };

  useEffect(() => {
    if (request.seq === 0) return;
    frame(request.action);
    report();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.seq]);

  // Frame the machine once when it first appears, or go back to where the camera was left on this device.
  useEffect(() => {
    if (!hasFramed.current && (structure.conveyors.length > 0 || structure.deltas.length > 0)) {
      hasFramed.current = true;
      if (!initial) frame("iso");
      else {
        camera.position.set(...initial.position);
        camera.lookAt(...initial.target);
        if (controls) {
          controls.target.set(...initial.target);
          controls.update();
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);

  return null;
}


/** Lit parts cast and receive shadows; overlays, which are unlit, never do. */
function castShadows(root: THREE.Object3D | null): void {
  root?.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const lit = (o as THREE.Mesh).material instanceof THREE.MeshStandardMaterial;
    o.castShadow = lit;
    o.receiveShadow = lit;
  });
}

/** A soft round spot, white in the middle and transparent at the rim, for the floor to fade into the stage. */
function fadeTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "#fff");
  gradient.addColorStop(0.55, "#fff");
  gradient.addColorStop(1, "#000");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Map size of the key light's shadow, in pixels per side. */
const SHADOW_MAP_SIZE = 2048;

/**
 * Everything around the machine: a neutral studio light without any download (generated, so it works on IPCs
 * without internet), a key light whose soft shadow covers the machine (high quality only), the floor at MCS Z = 0
 * that takes the shadows and fades into the background, and the measuring grid on it.
 */
function Stage({ bounds, quality }: { bounds: MachineBounds; quality: Quality }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04).texture;
    scene.environment = environment;
    scene.environmentIntensity = 0.5;
    room.dispose();
    pmrem.dispose();
    return () => {
      scene.environment = null;
      environment.dispose();
    };
  }, [gl, scene]);

  const floorFade = useMemo(fadeTexture, []);
  useEffect(() => () => floorFade.dispose(), [floorFade]);

  const light = useRef<THREE.DirectionalLight>(null);
  const { centre, radius } = useMemo(() => {
    const box = machineBox(bounds);
    return { centre: box.getCenter(new THREE.Vector3()), radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1) };
  }, [bounds]);
  useLayoutEffect(() => {
    const l = light.current;
    if (!l) return;
    // Nearly from above: a shadow stays under its part; seen from above it must not look like a second part.
    l.position.copy(centre).add(new THREE.Vector3(0.15, 1, 0.2).multiplyScalar(radius * 2));
    l.target.position.copy(centre);
    l.target.updateMatrixWorld();
    const margin = radius + 1;
    Object.assign(l.shadow.camera, { left: -margin, right: margin, top: margin, bottom: -margin, near: 0.1, far: radius * 6 });
    l.shadow.camera.updateProjectionMatrix();
  }, [centre, radius]);

  const floorRadius = radius * 1.6 + 4;
  return (
    <>
      <hemisphereLight args={["#dfe8f5", "#2a2f36", 0.55]} />
      <directionalLight
        ref={light}
        intensity={1.6}
        castShadow={quality === "high"}
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-intensity={0.55}
      />
      {/* A little below the grid, so the grid lines are never hidden by the floor. */}
      <mesh position={[centre.x, -0.002, centre.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow raycast={noRaycast} renderOrder={-1}>
        <circleGeometry args={[floorRadius, 64]} />
        <meshStandardMaterial color={STAGE.floor} roughness={1} alphaMap={floorFade} transparent depthWrite={false} />
      </mesh>
      <Grid
        args={[20, 20]}
        cellSize={0.1}
        sectionSize={1}
        cellColor={STAGE.gridCell}
        sectionColor={STAGE.gridSection}
        cellThickness={0.6}
        sectionThickness={1}
        fadeDistance={30}
        fadeStrength={1.5}
        infiniteGrid
      />
    </>
  );
}

/** Low quality renders at most at this resolution, in device pixels per CSS pixel. */
const LOW_DPR = 1;

/**
 * Measures the frame rate and reports the quality to render with whenever it changes.
 */
function QualityControl({ setting, onQuality }: { setting: QualitySetting; onQuality: (q: Quality) => void }) {
  const sampler = useRef(new FrameRateSampler());
  const current = useRef<Quality | undefined>(undefined);
  const report = () => {
    const q = qualityFor(setting, sampler.current.samples);
    if (q === current.current) return;
    current.current = q;
    onQuality(q);
  };
  useEffect(report, [setting]);
  useFrame((_, delta) => {
    // Once low on auto, nothing more to measure: it stays low.
    if (setting !== "auto" || current.current === "low") return;
    const before = sampler.current.samples.length;
    sampler.current.frame(delta);
    if (sampler.current.samples.length !== before) report();
  });
  return null;
}
/** Upper limit of the render resolution in device pixels per CSS pixel, for weak panel PC graphics. */
const MAX_DPR = 1.5;

export function SceneView(props: SceneViewProps) {
  // The last press on the canvas: a selection counts only if it was a tap, not a camera drag or a pinch.
  const press = useRef<{ start: ScreenPoint; end: ScreenPoint; type: string; multi: boolean } | null>(null);
  const pointersDown = useRef(new Set<number>());
  // Set when a tap ends; an object's click clears it again, otherwise the tap hit empty space.
  const emptyTap = useRef(false);
  const latestProps = useRef(props);
  latestProps.current = props;
  const wasTap = () => {
    const p = press.current;
    return !p || (!p.multi && isTap(p.start, p.end, p.type));
  };
  const onSelect = (selection: Selection) => {
    emptyTap.current = false;
    if (wasTap()) props.onSelect(selection);
  };

  // Releases are watched on the window: OrbitControls follows a drag on the document, so it may end outside the
  // canvas. A cancelled pointer (e.g. the browser took over the touch) makes the press no tap.
  useEffect(() => {
    const release = (e: PointerEvent, cancelled: boolean) => {
      if (!pointersDown.current.delete(e.pointerId)) return;
      const p = press.current;
      if (!p) return;
      if (cancelled) p.multi = true;
      if (pointersDown.current.size > 0) return;
      p.end = { x: e.clientX, y: e.clientY };
      if (!wasTap()) return;
      // R3F reports a missed click only below 2 px of travel, too strict for a finger: decide here instead. The
      // click, and with it an object's onClick, follows this pointerup before the timeout runs.
      emptyTap.current = true;
      setTimeout(() => {
        if (emptyTap.current && !latestProps.current.measureMode) latestProps.current.onSelect(undefined);
        emptyTap.current = false;
      }, 0);
    };
    const onUp = (e: PointerEvent) => release(e, false);
    const onCancel = (e: PointerEvent) => release(e, true);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // High until the quality control has measured otherwise.
  const [quality, setQuality] = useState<Quality>("high");

  return (
    <Canvas
      camera={{ position: [4, 3, 4], fov: 45, near: 0.01, far: 200 }}
      dpr={[1, quality === "high" ? MAX_DPR : LOW_DPR]}
      shadows="soft"
      // Neutral tone mapping keeps the palette colours of lit parts close to what they are.
      gl={{ toneMapping: THREE.NeutralToneMapping }}
      onPointerDown={(e) => {
        if (pointersDown.current.size > 0 && press.current) press.current.multi = true;
        else {
          const at = { x: e.clientX, y: e.clientY };
          press.current = { start: at, end: at, type: e.pointerType, multi: false };
        }
        pointersDown.current.add(e.pointerId);
      }}
    >
      <QualityControl
        setting={props.quality}
        onQuality={(q) => {
          setQuality(q);
          props.onQuality?.(q);
        }}
      />
      <SceneContent {...props} onSelect={onSelect} renderQuality={quality} />
      {/* One finger orbits, two pinch and pan; in measure mode one finger picks a point instead. */}
      <OrbitControls
        makeDefault
        touches={{ ONE: props.measureMode ? NO_TOUCH_ACTION : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
      />
    </Canvas>
  );
}

/** OrbitControls ignores a one-finger gesture whose action is none of THREE.TOUCH. */
const NO_TOUCH_ACTION = -1 as THREE.TOUCH;
