import { Grid, Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import type { GatewayStore } from "../connection";
import type { ProductDisplay, SceneDelta, SceneModel, SceneProduct, Transform, Vec3 } from "./scene-model";
import { buildScene, mcsToRenderer, rendererToMcs } from "./scene-model";
import type { ConfigMessage, ProductState } from "@rpp/protocol";

export interface Layers {
  workAreas: boolean;
  windows: boolean;
  tcpMarkers: boolean;
}

/** A product is selected by register identity, so the selection survives display changes (e.g. picked). */
export type Selection =
  | { kind: "component"; id: number }
  | { kind: "product"; conveyorId: number; productId: number }
  | undefined;

export type CameraPreset = "top" | "front" | "iso";

/** A point in the scene under the pointer, in MCS millimetres, with what was hit. */
export interface McsHit {
  point: Vec3;
  label: string;
}

/** A measuring point placed with Shift+click. */
export interface McsPin extends McsHit {
  id: number;
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
  /** Called on every pointer move with the MCS point under the pointer (undefined when leaving the scene). */
  onPointerMcs: (hit: McsHit | undefined) => void;
  /** Shift+click places a measuring point. */
  onPin: (hit: McsHit) => void;
  pins: McsPin[];
}

const EMPTY: SceneModel = { conveyors: [], products: [], deltas: [], workAreas: [], windows: [], warnings: [] };

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

/** Label of the nearest object (or ancestor) that carries one in userData. */
function labelOf(object: THREE.Object3D | null): string {
  for (let o = object; o; o = o.parent) if (typeof o.userData.label === "string") return o.userData.label;
  return "";
}

/** Formats an MCS point as "X / Y / Z" in mm. */
export function formatMcs(p: Vec3): string {
  return p.map((v) => v.toFixed(1)).join(" / ");
}

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
    m.windows.map((w) => `${w.robotId}:${w.conveyorId}:${w.kind}`).join(","),
  ].join("|");
}

function SceneContent(props: SceneViewProps) {
  const { store, config, layers, selection, onSelect, modelRef, onPointerMcs, onPin, pins } = props;
  const hoverMarker = useRef<THREE.Mesh>(null);

  const hitFrom = (e: ThreeEvent<PointerEvent | MouseEvent>): McsHit => ({
    point: rendererToMcs([e.point.x, e.point.y, e.point.z]),
    label: labelOf(e.object),
  });
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    // Only the nearest intersection counts.
    e.stopPropagation();
    onPointerMcs(hitFrom(e));
    if (hoverMarker.current) {
      hoverMarker.current.visible = true;
      hoverMarker.current.position.copy(e.point);
    }
  };
  const onLeave = () => {
    onPointerMcs(undefined);
    if (hoverMarker.current) hoverMarker.current.visible = false;
  };
  const onRootClick = (e: ThreeEvent<MouseEvent>) => {
    if (!e.shiftKey) return;
    e.stopPropagation();
    onPin(hitFrom(e));
  };
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
      <mesh ref={hoverMarker} raycast={noRaycast} visible={false}>
        <sphereGeometry args={[0.008, 12, 12]} />
        <meshBasicMaterial color="#ffffff" depthTest={false} transparent />
      </mesh>
      {pins.map((p) => (
        <group key={p.id} position={mcsToRenderer(p.point)}>
          <mesh raycast={noRaycast}>
            <sphereGeometry args={[0.012, 12, 12]} />
            <meshBasicMaterial color={SELECT_COLOR} depthTest={false} transparent />
          </mesh>
          <Html className="pin-label" zIndexRange={[20, 10]} style={{ pointerEvents: "none" }}>
            #{p.id} {formatMcs(p.point)}
          </Html>
        </group>
      ))}
      <group onPointerMove={onMove} onPointerOut={onLeave} onClick={onRootClick}>
      {/* Floor at MCS Z = 0: catches the pointer where nothing else is hit. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        userData={{ label: "Floor (Z = 0)" }}
        onClick={(e) => {
          if (!e.shiftKey) onSelect(undefined);
        }}
      >
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
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
              if (e.shiftKey) return;
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
      {layers.workAreas &&
        structure.workAreas.map((w) => (
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
      {layers.windows &&
        structure.windows.map((w, i) => (
          <group key={`${w.robotId}:${i}`} ref={(o) => applyTransform(o, w.transform)}>
            <mesh position={[0, 0.003, 0]} userData={{ label: `${w.kind === "pick" ? "Pick" : "Place"} window (robot #${w.robotId})` }}>
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
      </group>
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
        if (e.shiftKey) return;
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
    if (e.shiftKey) return;
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
      onPointerMissed={() => props.onSelect(undefined)}
    >
      <color attach="background" args={["#1d2128"]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 10, 5]} intensity={1.2} />
      <SceneContent {...props} />
      <OrbitControls makeDefault />
    </Canvas>
  );
}
