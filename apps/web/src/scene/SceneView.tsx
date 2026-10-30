import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import type { GatewayStore } from "../connection";
import type {
  ProductDisplay,
  SceneDelta,
  SceneGantry,
  SceneLoop,
  SceneModel,
  SceneOrigin,
  SceneProduct,
  SnapPoint,
  Transform,
  Vec3,
} from "./scene-model";
import { availableSnapPoints, buildScene } from "./scene-model";
import type { ConfigMessage, ProductState } from "@rpp/protocol";

export interface Layers {
  workingAreas: boolean;
  zones: boolean;
  tcpMarkers: boolean;
}

/** A product is selected by register identity, so the selection survives display changes (e.g. picked). */
export type Selection =
  | { kind: "component"; id: number }
  | { kind: "product"; conveyorId: number; productId: number }
  | undefined;

export type CameraPreset = "top" | "front" | "iso";

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
  store: GatewayStore;
  config: ConfigMessage | undefined;
  layers: Layers;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** Changes to `{ preset, seq }` move the camera; `seq` allows repeating the same preset. */
  cameraRequest: { preset: CameraPreset; seq: number };
  /** Receives the scene model every frame, e.g. for the inspector. */
  modelRef: MutableRefObject<SceneModel | undefined>;
  /** Measure mode: origins and snap points are shown, a click on a snap point measures instead of selecting. */
  measureMode: boolean;
  /** Called with the snap point under the pointer when it is clicked in measure mode. */
  onMeasure: (point: SnapPoint) => void;
  measurePoints: MeasurePoint[];
}

const EMPTY: SceneModel = {
  conveyors: [],
  products: [],
  deltas: [],
  workingAreas: [],
  zones: [],
  gantries: [],
  gantryAreas: [],
  loops: [],
  snapPoints: [],
  origins: [],
  warnings: [],
};

/** Snap radius on screen, CSS pixels. */
const SNAP_RADIUS_PX = 12;
/** Pointer travel below which a press counts as a click rather than a camera drag, CSS pixels. */
const CLICK_TOLERANCE_PX = 4;

export const PRODUCT_COLORS: Record<ProductState, string> = {
  detected: "#8fa8c8",
  assigned: "#e0a030",
  picked: "#3cb371",
  rejected: "#9370db",
  placed: "#40b0b0",
};
export const MISSED_COLOR = "#e53935";
const SELECT_COLOR = "#ffd54f";

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
    m.gantryAreas.map((a) => `${a.robotId}:${a.size.join("/")}`).join(","),
    m.loops.map((l) => `${l.id}:${l.straightLength}:${l.curveRadius}:${l.movers.map((x) => x.id).join("/")}`).join(","),
  ].join("|");
}

function SceneContent(props: SceneViewProps) {
  const { store, config, layers, selection, modelRef, measureMode, onMeasure, measurePoints } = props;
  // In measure mode a click measures; selecting works only through the component tree.
  const onSelect = measureMode ? () => {} : props.onSelect;
  const latest = useRef<SceneModel>(EMPTY);
  const [structure, setStructure] = useState<SceneModel>(EMPTY);
  const sig = useRef("");
  const productIndex = useRef(new Map<string, SceneProduct>());
  // A new config can change geometry without changing ids: force a structural update.
  useEffect(() => {
    sig.current = "";
  }, [config]);

  useFrame(() => {
    const model = buildScene(config, store.snapshots, store.renderTime());
    latest.current = model;
    productIndex.current = new Map(model.products.map((p) => [p.key, p]));
    modelRef.current = model;
    const s = signature(model);
    if (s !== sig.current) {
      sig.current = s;
      setStructure(model);
    }
  });

  const productByKey = (key: string) => productIndex.current.get(key);
  const isSelected = (id: number) => selection?.kind === "component" && selection.id === id;

  return (
    <>
      <McsAxes />
      <MeasurePoints points={measurePoints} />
      {measureMode && (
        <MeasureLayer
          latest={latest}
          structure={structure}
          layers={layers}
          onMeasure={onMeasure}
        />
      )}
      <Grid
        args={[20, 20]}
        cellSize={0.1}
        sectionSize={1}
        cellColor="#3a4250"
        sectionColor="#5a6577"
        fadeDistance={30}
        infiniteGrid
      />
      {structure.conveyors.map((c) => (
        <group key={c.id} ref={(o) => applyTransform(o, c.transform)}>
          <mesh
            position={[c.length / 2, -0.025, 0]}
            userData={{ label: c.name }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect({ kind: "component", id: c.id });
            }}
          >
            <boxGeometry args={[c.length, 0.05, c.width]} />
            <meshStandardMaterial color={isSelected(c.id) ? "#5c6b3a" : "#454c57"} />
          </mesh>
          {/* Conveying direction */}
          <mesh position={[c.length + 0.06, 0, 0]} rotation={[0, 0, -Math.PI / 2]} raycast={noRaycast}>
            <coneGeometry args={[0.04, 0.12, 16]} />
            <meshStandardMaterial color="#9aa5b5" />
          </mesh>
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
      {layers.workingAreas &&
        structure.gantryAreas.map((a) => (
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
          </group>
        ))}
      <CameraRig request={props.cameraRequest} structure={structure} />
    </>
  );
}

function ProductMesh(props: {
  product: SceneProduct;
  selected: boolean;
  lookup: (key: string) => SceneProduct | undefined;
  onSelect: (s: Selection) => void;
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
  onSelect: (s: Selection) => void;
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
 * pointer (within SNAP_RADIUS_PX on screen, also when occluded) highlighted with its name. A click without camera
 * drag measures the highlighted point.
 */
function MeasureLayer(props: {
  latest: MutableRefObject<SceneModel>;
  structure: SceneModel;
  layers: Layers;
  onMeasure: (point: SnapPoint) => void;
}) {
  const { latest, structure, layers, onMeasure } = props;
  const { camera, gl } = useThree();
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hovered = useRef<SnapPoint | null>(null);
  const marker = useRef<THREE.Group>(null);
  const [label, setLabel] = useState<string | null>(null);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    const position = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => (pointer.current = position(e));
    const onLeave = () => (pointer.current = null);
    const onDown = (e: PointerEvent) => (down = e.button === 0 ? position(e) : null);
    const onUp = (e: PointerEvent) => {
      const p = position(e);
      const start = down;
      down = null;
      if (!start || Math.hypot(p.x - start.x, p.y - start.y) > CLICK_TOLERANCE_PX) return;
      if (hovered.current) onMeasureRef.current(hovered.current);
    };
    el.style.cursor = "crosshair";
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.style.cursor = "";
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [gl]);

  useFrame(() => {
    // Re-evaluated every frame: moving snap points pass under a still pointer.
    const p = pointer.current;
    let best: { point: SnapPoint; px: number; depth: number } | null = null;
    if (p) {
      const width = gl.domElement.clientWidth;
      const height = gl.domElement.clientHeight;
      const v = new THREE.Vector3();
      for (const point of availableSnapPoints(latest.current.snapPoints, layers)) {
        v.set(...point.position).project(camera);
        if (v.z < -1 || v.z > 1) continue;
        const px = Math.hypot(((v.x + 1) / 2) * width - p.x, ((1 - v.y) / 2) * height - p.y);
        if (px > SNAP_RADIUS_PX) continue;
        const depth = camera.position.distanceTo(new THREE.Vector3(...point.position));
        // Nearest on screen; on a tie the one nearer to the camera.
        if (!best || px < best.px - 0.5 || (Math.abs(px - best.px) <= 0.5 && depth < best.depth)) {
          best = { point, px, depth };
        }
      }
    }
    hovered.current = best?.point ?? null;
    if (marker.current) {
      marker.current.visible = best !== null;
      if (best) marker.current.position.set(...best.point.position);
    }
    const next = best?.point.label ?? null;
    if (next !== label) setLabel(next);
  });

  const dots = availableSnapPoints(structure.snapPoints, layers).filter((p) => !p.moving);
  return (
    <>
      {structure.origins.map((o) => (
        <OriginTriad key={o.componentId} origin={o} />
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
          <Html className="snap-label" zIndexRange={[30, 20]} style={{ pointerEvents: "none" }}>
            {label}
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
  onSelect: (s: Selection) => void;
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

  return (
    <group userData={{ label: name }}>
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
        <group key={m.id}>
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
            {/* Orientation mark along the gripper's local +X (C). */}
            <mesh position={[0.02, 0.013, 0]} raycast={noRaycast}>
              <boxGeometry args={[0.02, 0.003, 0.004]} />
              <meshBasicMaterial color="#ffffff" />
            </mesh>
          </group>
        </group>
      ))}
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
  onSelect: (s: Selection) => void;
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

  return (
    <group userData={{ label: name }}>
      <group ref={base}>
        <mesh geometry={band} onClick={select}>
          <meshStandardMaterial color={selected ? "#5c6b3a" : XTS_COLORS.track} metalness={0.4} roughness={0.5} />
        </mesh>
        <Html position={[straightLength / 2, curveRadius, 0]} className="label" zIndexRange={[10, 0]}>
          {name}
        </Html>
      </group>
      {loop.movers.map((m, i) => (
        <group key={m.id}>
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
        </group>
      ))}
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

function CameraRig({ request, structure }: { request: { preset: CameraPreset; seq: number }; structure: SceneModel }) {
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
    if (request.seq > 0) frame(request.preset);
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

export function SceneView(props: SceneViewProps) {
  return (
    <Canvas
      camera={{ position: [4, 3, 4], fov: 45, near: 0.01, far: 200 }}
      onPointerMissed={() => {
        if (!props.measureMode) props.onSelect(undefined);
      }}
    >
      <color attach="background" args={["#1d2128"]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 10, 5]} intensity={1.2} />
      <SceneContent {...props} />
      <OrbitControls makeDefault />
    </Canvas>
  );
}
