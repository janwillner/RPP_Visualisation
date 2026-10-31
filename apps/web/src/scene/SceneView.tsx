import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import * as THREE from "three";
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
/** A preset view, or a zoom step towards / away from the orbit target (for single-finger use). */
export type CameraAction = CameraPreset | "zoomIn" | "zoomOut";

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
  cameraRequest: { action: CameraAction; seq: number };
  /** Receives the machine scene every frame, e.g. for the inspector. */
  modelRef: MutableRefObject<MachineScene | undefined>;
  /** Measure mode: origins and snap points are shown, a click on a snap point measures instead of selecting. */
  measureMode: boolean;
  /** Called with the snap point under the pointer when it is clicked in measure mode. */
  onMeasure: (point: SnapPoint) => void;
  measurePoints: MeasurePoint[];
  /** Component keys and source ids hidden by the user. */
  hidden: ReadonlySet<string>;
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


export const PRODUCT_COLORS: Record<ProductState, string> = {
  detected: "#8fa8c8",
  assigned: "#e0a030",
  picked: "#3cb371",
  rejected: "#9370db",
  placed: "#40b0b0",
};
export const MISSED_COLOR = "#e53935";
const SELECT_COLOR = "#ffd54f";
/** Belt surface: dark blue, so it stands out from the near-black background and the light products. */
const CONVEYOR_COLOR = "#1f4e9c";
const CONVEYOR_SELECTED_COLOR = "#3d78d8";
/** Faulted components and movers glow in this colour; a selection highlight stays visible underneath. */
const FAULT_COLOR = "#e53935";

/**
 * Tints every standard material below `root` red while `faulted`, except inside nested fault scopes, which tint
 * themselves (a faulted mover inside a gantry without fault).
 */
function tint(root: THREE.Object3D | null, faulted: boolean): void {
  if (!root) return;
  const visit = (o: THREE.Object3D) => {
    const material = (o as THREE.Mesh).material;
    if (material instanceof THREE.MeshStandardMaterial) {
      material.emissive.set(faulted ? FAULT_COLOR : "#000000");
      material.emissiveIntensity = faulted ? 0.9 : 1;
    }
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

/** A group whose content is faded while `offline`. Re-applied on every render, so new meshes are covered. */
function OfflineScope({ offline, children }: { offline: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => fade(ref.current, offline));
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

function SceneContent(props: SceneViewProps) {
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
      <Grid
        args={[20, 20]}
        cellSize={0.1}
        sectionSize={1}
        cellColor="#3a4250"
        sectionColor="#5a6577"
        fadeDistance={30}
        infiniteGrid
      />
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
      <CameraRig request={props.cameraRequest} structure={bounds} />
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
            <mesh
              position={[c.length / 2, -0.025, 0]}
              userData={{ label: c.name }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect({ kind: "component", id: c.id });
              }}
            >
              <boxGeometry args={[c.length, 0.05, c.width]} />
              <meshStandardMaterial color={isSelected(c.id) ? CONVEYOR_SELECTED_COLOR : CONVEYOR_COLOR} />
            </mesh>
            {/* Conveying direction */}
            <mesh position={[c.length + 0.06, 0, 0]} rotation={[0, 0, -Math.PI / 2]} raycast={noRaycast}>
              <coneGeometry args={[0.04, 0.12, 16]} />
              <meshStandardMaterial color="#9aa5b5" />
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
          <mesh key={`box:${a.robotId}`} ref={(o) => applyTransform(o, a.transform)} raycast={noRaycast}>
            {/* Renderer local axes: MCS X -> x, MCS Z -> y, MCS Y -> −z. */}
            <boxGeometry args={[a.size[0], a.size[2], a.size[1]]} />
            <meshBasicMaterial
              color={isSelected(a.robotId) ? SELECT_COLOR : "#4fc3f7"}
              transparent
              opacity={0.12}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        ))}
      {layers.limitAreas &&
        structure.limitAreas.map((a) => (
          <LimitAreaMesh key={`limit:${a.robotId}`} area={a} selected={isSelected(a.robotId)} />
        ))}
      {layers.workingAreas &&
        structure.workingAreas.map((w) => (
          <group key={w.robotId} ref={(o) => applyTransform(o, w.transform)}>
            <mesh position={[0, (w.zMin + w.zMax) / 2, 0]} raycast={noRaycast}>
              <cylinderGeometry args={[w.radius, w.radius, w.zMax - w.zMin, 48, 1, true]} />
              <meshBasicMaterial
                color={isSelected(w.robotId) ? SELECT_COLOR : "#4fc3f7"}
                transparent
                opacity={0.12}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
            {w.coneHeight > 0 && (
              <mesh position={[0, w.zMin - w.coneHeight / 2, 0]} raycast={noRaycast}>
                <cylinderGeometry args={[w.radius, w.coneBottomRadius, w.coneHeight, 48, 1, true]} />
                <meshBasicMaterial color="#4fc3f7" transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
              </mesh>
            )}
          </group>
        ))}
      {layers.zones &&
        structure.zones.map((w, i) => (
          <group key={`${w.robotId}:${i}`} ref={(o) => applyTransform(o, w.transform)}>
            <mesh position={[0, 0.003, 0]} userData={{ label: `${w.kind === "pick" ? "Pick" : "Place"} zone (robot #${w.robotId})` }}>
              <boxGeometry args={[w.length, 0.004, w.width]} />
              <meshBasicMaterial
                color={w.kind === "pick" ? "#66bb6a" : "#42a5f5"}
                transparent
                opacity={isSelected(w.robotId) ? 0.55 : 0.3}
                depthWrite={false}
              />
            </mesh>
            {w.allocation && (
              <AllocationMesh
                allocation={w.allocation}
                zone={w}
                color={w.kind === "pick" ? "#2e7d32" : "#1565c0"}
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
        color="#000000"
        lineWidth={2}
        dashed
        dashSize={0.03}
        gapSize={0.02}
        raycast={noRaycast}
      />
    </group>
  );
}

const LIMIT_AREA_COLOR = "#ff9800";

/** Limit area: translucent box with solid edges, so it stays distinguishable from the working area. */
function LimitAreaMesh({ area, selected }: { area: SceneBoxArea; selected: boolean }) {
  // Renderer local axes: MCS X -> x, MCS Z -> y, MCS Y -> −z.
  const edges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(area.size[0], area.size[2], area.size[1])),
    [area.size[0], area.size[1], area.size[2]],
  );
  const color = selected ? SELECT_COLOR : LIMIT_AREA_COLOR;
  return (
    <group ref={(o) => applyTransform(o, area.transform)}>
      <mesh raycast={noRaycast}>
        <boxGeometry args={[area.size[0], area.size[2], area.size[1]]} />
        <meshBasicMaterial color={color} transparent opacity={0.06} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments geometry={edges} raycast={noRaycast}>
        <lineBasicMaterial color={color} />
      </lineSegments>
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
      <mesh position={[allocation.centre, 0.006, 0]} raycast={noRaycast}>
        <boxGeometry args={[allocation.length, 0.004, zone.width]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.6 : 0.35} depthWrite={false} />
      </mesh>
      <mesh position={[allocation.limit, 0.008, 0]} raycast={noRaycast}>
        <boxGeometry args={[0.012, 0.006, zone.width]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </>
  );
}

const FINGER_COLORS = { active: "#3cb371", idle: "#8a939e", rod: "#5d6570" };

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
    material.current?.emissive.set(live?.faulted ? FAULT_COLOR : "#000000");
    if (material.current) material.current.emissiveIntensity = live?.faulted ? 0.9 : 1;
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
  return (
    <mesh
      ref={(m) => {
        ref.current = m;
        applyTransform(m, product.transform);
      }}
      userData={{ label: `Product #${product.productId} (${product.display})` }}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onSelect({ kind: "product", conveyorId: product.conveyorId, productId: product.productId });
      }}
    >
      <boxGeometry args={[product.size.length, product.size.height, product.size.width]} />
      {display === "placeholder" ? (
        <meshBasicMaterial color={color} wireframe transparent opacity={0.7} />
      ) : (
        <meshStandardMaterial color={color} emissive={display === "missed" ? MISSED_COLOR : "#000"} emissiveIntensity={0.4} />
      )}
    </mesh>
  );
}

const ARM_AZIMUTHS = [0, 120, 240].map((deg) => (deg * Math.PI) / 180);
const DELTA_COLORS = {
  plate: "#b9bec4",
  arm: "#26282b",
  motor: "#1c1d1f",
  gearbox: "#8d949b",
  rod: "#2e3135",
  joint: "#c9ced3",
  effector: "#d5d9dd",
};
/** Half the spacing between the two rods of a lower-arm parallelogram, metres. */
const ROD_HALF_SPACING = 0.035;
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

function trianglePlateShape(radius: number): THREE.Shape {
  return new THREE.Shape(
    [90, 210, 330].map((deg) => {
      const a = (deg * Math.PI) / 180;
      return new THREE.Vector2(Math.cos(a), Math.sin(a)).multiplyScalar(radius);
    }),
  );
}

/** Small arrow along +Y of its own frame, for the TCP axis triad. */
function TriadArrow({ color, quaternion }: { color: string; quaternion: THREE.Quaternion }) {
  return (
    <group quaternion={quaternion}>
      <mesh position={[0, 0.04, 0]} raycast={noRaycast}>
        <cylinderGeometry args={[0.003, 0.003, 0.08, 8]} />
        <meshBasicMaterial color={color} depthTest={false} transparent />
      </mesh>
      <mesh position={[0, 0.088, 0]} raycast={noRaycast}>
        <coneGeometry args={[0.008, 0.018, 12]} />
        <meshBasicMaterial color={color} depthTest={false} transparent />
      </mesh>
    </group>
  );
}

// Triad in the effector's local frame: MCS X -> local +X, MCS Y -> local -Z, MCS Z -> local +Y.
const TRIAD = [
  { color: "#ef5350", quaternion: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(1, 0, 0)) },
  { color: "#66bb6a", quaternion: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(0, 0, -1)) },
  { color: "#42a5f5", quaternion: new THREE.Quaternion() },
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
    const effectorPlate = new THREE.ExtrudeGeometry(trianglePlateShape(effectorRadius * 1.6), {
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
            <meshStandardMaterial color={highlight ?? DELTA_COLORS.plate} metalness={0.3} roughness={0.6} />
          </mesh>
          {parts.motors.map((m, i) => (
            <group key={i}>
              <mesh position={m.hub} quaternion={m.quaternion} onClick={select}>
                <cylinderGeometry args={[0.035, 0.035, 0.05, 20]} />
                <meshStandardMaterial color={DELTA_COLORS.gearbox} metalness={0.5} roughness={0.4} />
              </mesh>
              <mesh position={m.gearbox} quaternion={m.quaternion} onClick={select}>
                <cylinderGeometry args={[0.03, 0.03, 0.05, 20]} />
                <meshStandardMaterial color={DELTA_COLORS.gearbox} metalness={0.5} roughness={0.4} />
              </mesh>
              <mesh position={m.motor} quaternion={m.quaternion} onClick={select}>
                <boxGeometry args={[0.06, 0.11, 0.06]} />
                <meshStandardMaterial color={DELTA_COLORS.motor} roughness={0.7} />
              </mesh>
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
                <meshStandardMaterial color={DELTA_COLORS.joint} metalness={0.6} roughness={0.3} />
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
                <meshStandardMaterial color={DELTA_COLORS.joint} metalness={0.6} roughness={0.3} />
              </mesh>
            ))}
          </group>
        ))}
        <group ref={effector} userData={{ label: name + " TCP" }}>
          <mesh geometry={parts.effectorPlate} onClick={select}>
            <meshStandardMaterial color={DELTA_COLORS.effector} metalness={0.5} roughness={0.35} />
          </mesh>
          {showTcp && TRIAD.map((t) => <TriadArrow key={t.color} color={t.color} quaternion={t.quaternion} />)}
        </group>
        <mesh ref={setpoint} userData={{ label: name + " setpoint TCP" }}>
          <octahedronGeometry args={[0.018]} />
          <meshBasicMaterial color="#ffee58" wireframe depthTest={false} transparent />
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
        <Line points={points.map((p) => p.position)} color={SELECT_COLOR} lineWidth={1.5} depthTest={false} transparent />
      )}
      {points.map((p) => (
        <group key={p.id} position={p.position}>
          <mesh raycast={noRaycast} renderOrder={10}>
            <sphereGeometry args={[0.012, 12, 12]} />
            <meshBasicMaterial color={SELECT_COLOR} depthTest={false} transparent />
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
          <meshBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0.8} />
        </mesh>
      ))}
      <group ref={marker} visible={false}>
        <mesh raycast={noRaycast} renderOrder={11}>
          <sphereGeometry args={[0.014, 14, 14]} />
          <meshBasicMaterial color={SELECT_COLOR} depthTest={false} transparent opacity={0.9} />
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
          [[1, 0, 0], "#ef5350"],
          [[0, 0, -1], "#66bb6a"],
          [[0, 1, 0], "#42a5f5"],
        ] as const
      ).map(([dir, color]) => {
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(...dir), new THREE.Vector3(), 0.3, color, 0.05, 0.025);
        arrow.traverse((o) => {
          o.renderOrder = 6;
          const material = (o as THREE.Mesh).material as THREE.Material | undefined;
          if (material) {
            material.depthTest = false;
            material.transparent = true;
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
  beam: "#3a3f46",
  module: "#1c1f23",
  mover: "#c9ced3",
  arm: "#26282b",
  cup: "#2f7fd6",
  cupActive: "#66bb6a",
  track: "#3a3f46",
  tool: "#ffb74d",
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
          <mesh position={[0, 0.06, -trackLength / 2]} onClick={select}>
            <boxGeometry args={[moverWidth + 0.04, 0.12, trackLength]} />
            <meshStandardMaterial color={selected ? "#5c6b3a" : XTS_COLORS.beam} metalness={0.4} roughness={0.5} />
          </mesh>
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
              <mesh position={[0, -0.02, 0]} onClick={select}>
                <boxGeometry args={[moverWidth, 0.04, moverLength]} />
                <meshStandardMaterial color={selected ? SELECT_COLOR : XTS_COLORS.mover} metalness={0.4} roughness={0.4} />
              </mesh>
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
            <meshStandardMaterial color={selected ? "#5c6b3a" : XTS_COLORS.track} metalness={0.4} roughness={0.5} />
          </mesh>
          <Html position={[straightLength / 2, curveRadius, 0]} className="label" zIndexRange={[10, 0]}>
            {name}
          </Html>
        </group>
        {loop.movers.map((m, i) => (
          <FaultScope key={m.id} faulted={loopFaulted || m.fault !== null}>
            <group ref={(o) => (movers.current[i] = o)}>
              {/* Outwards is the mover's local −Y (MCS −Z). */}
              <mesh position={[0, -0.03, 0]} onClick={select}>
                <boxGeometry args={[moverLength, 0.04, moverWidth]} />
                <meshStandardMaterial color={selected ? SELECT_COLOR : XTS_COLORS.mover} metalness={0.4} roughness={0.4} />
              </mesh>
              <Html position={[0, -0.07, moverWidth / 2]} className="label" zIndexRange={[10, 0]}>
                {m.id}
              </Html>
            </group>
            <mesh ref={(o) => (tools.current[i] = o)} raycast={noRaycast}>
              <sphereGeometry args={[0.008, 10, 10]} />
              <meshBasicMaterial color={XTS_COLORS.tool} />
            </mesh>
          </FaultScope>
        ))}
      </FaultScope>
    </group>
  );
}

const CARTESIAN_COLORS: Record<SceneCartesian["parts"][number]["key"], string> = {
  "rail left": "#3a3f46",
  "rail right": "#3a3f46",
  bridge: "#5d6570",
  carriage: "#c9ced3",
  column: "#8a939e",
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
          <mesh key={p.key} ref={(o) => (parts.current[i] = o)} onClick={select}>
            {/* Renderer local axes: MCS X -> x, MCS Z -> y, MCS Y -> −z. */}
            <boxGeometry args={[p.size[0], p.size[2], p.size[1]]} />
            <meshStandardMaterial
              color={selected ? (p.key === "carriage" ? SELECT_COLOR : "#5c6b3a") : CARTESIAN_COLORS[p.key]}
              metalness={0.4}
              roughness={0.5}
            />
          </mesh>
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
      return arrow;
    };
    // MCS X -> renderer +X, MCS Y -> renderer −Z, MCS Z -> renderer +Y.
    return [make([1, 0, 0], "#ef5350"), make([0, 0, -1], "#66bb6a"), make([0, 1, 0], "#42a5f5")];
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

/** Factor by which one zoom step changes the distance to the orbit target. */
const ZOOM_STEP = 0.8;

/** Frames the conveyors and Delta bases of all sources. */
function CameraRig(props: {
  request: { action: CameraAction; seq: number };
  structure: { conveyors: SceneConveyor[]; deltas: SceneDelta[] };
}) {
  const { request, structure } = props;
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update(): void } | null };
  const hasFramed = useRef(false);

  const frame = (preset: CameraPreset) => {
    const box = new THREE.Box3();
    for (const c of structure.conveyors) {
      box.expandByPoint(new THREE.Vector3(...c.transform.position));
      const end = new THREE.Vector3(c.length, 0, 0).applyQuaternion(new THREE.Quaternion(...c.transform.quaternion));
      box.expandByPoint(new THREE.Vector3(...c.transform.position).add(end));
    }
    for (const d of structure.deltas) box.expandByPoint(new THREE.Vector3(...d.base.position));
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
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

  /** Moves the camera towards (factor < 1) or away from the orbit target, keeping the view direction. */
  const zoom = (factor: number) => {
    const target = controls?.target ?? new THREE.Vector3();
    camera.position.sub(target).multiplyScalar(factor).add(target);
    controls?.update();
  };

  useEffect(() => {
    if (request.seq === 0) return;
    if (request.action === "zoomIn") zoom(ZOOM_STEP);
    else if (request.action === "zoomOut") zoom(1 / ZOOM_STEP);
    else frame(request.action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.seq]);

  // Frame the machine once when it first appears.
  useEffect(() => {
    if (!hasFramed.current && (structure.conveyors.length > 0 || structure.deltas.length > 0)) {
      hasFramed.current = true;
      frame("iso");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);

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

  return (
    <Canvas
      camera={{ position: [4, 3, 4], fov: 45, near: 0.01, far: 200 }}
      dpr={[1, MAX_DPR]}
      onPointerDown={(e) => {
        if (pointersDown.current.size > 0 && press.current) press.current.multi = true;
        else {
          const at = { x: e.clientX, y: e.clientY };
          press.current = { start: at, end: at, type: e.pointerType, multi: false };
        }
        pointersDown.current.add(e.pointerId);
      }}
    >
      <color attach="background" args={["#1d2128"]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 10, 5]} intensity={1.2} />
      <SceneContent {...props} onSelect={onSelect} />
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
