import { Grid, Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import type { GatewayStore } from "../connection";
import type { ProductDisplay, SceneModel, SceneProduct, Transform, Vec3 } from "./scene-model";
import { buildScene } from "./scene-model";
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
    m.deltas.map((d) => d.id).join(","),
    m.windows.map((w) => `${w.robotId}:${w.conveyorId}:${w.kind}`).join(","),
  ].join("|");
}

function SceneContent(props: SceneViewProps) {
  const { store, config, layers, selection, onSelect, modelRef } = props;
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
            onClick={(e) => {
              e.stopPropagation();
              onSelect({ kind: "component", id: c.id });
            }}
          >
            <boxGeometry args={[c.length, 0.05, c.width]} />
            <meshStandardMaterial color={isSelected(c.id) ? "#5c6b3a" : "#454c57"} />
          </mesh>
          {/* Conveying direction */}
          <mesh position={[c.length + 0.06, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
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
          id={d.id}
          name={d.name}
          latest={latest}
          showTcp={layers.tcpMarkers}
          selected={isSelected(d.id)}
          onSelect={onSelect}
        />
      ))}
      {layers.workAreas &&
        structure.workAreas.map((w) => (
          <group key={w.robotId} ref={(o) => applyTransform(o, w.transform)}>
            <mesh position={[0, (w.zMin + w.zMax) / 2, 0]}>
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
              <mesh position={[0, w.zMin - w.coneHeight / 2, 0]}>
                <cylinderGeometry args={[w.radius, w.coneBottomRadius, w.coneHeight, 48, 1, true]} />
                <meshBasicMaterial color="#4fc3f7" transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
              </mesh>
            )}
          </group>
        ))}
      {layers.windows &&
        structure.windows.map((w, i) => (
          <group key={`${w.robotId}:${i}`} ref={(o) => applyTransform(o, w.transform)}>
            <mesh position={[0, 0.003, 0]}>
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

function DeltaMesh(props: {
  id: number;
  name: string;
  latest: MutableRefObject<SceneModel>;
  showTcp: boolean;
  selected: boolean;
  onSelect: (s: Selection) => void;
}) {
  const { id, name, latest, showTcp, selected, onSelect } = props;
  const base = useRef<THREE.Group>(null);
  const effector = useRef<THREE.Group>(null);
  const upper = useRef<(THREE.Mesh | null)[]>([]);
  const lower = useRef<(THREE.Mesh | null)[]>([]);
  const actual = useRef<THREE.Mesh>(null);
  const setpoint = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const d = latest.current.deltas.find((x) => x.id === id);
    if (!d) return;
    applyTransform(base.current, d.base);
    if (effector.current) {
      effector.current.visible = d.effector !== null;
      applyTransform(effector.current, d.effector ?? undefined);
    }
    for (let i = 0; i < 3; i++) {
      placeBetween(upper.current[i] ?? null, d.shoulders[i], d.elbows[i]);
      placeBetween(lower.current[i] ?? null, d.elbows[i], d.effectorJoints[i]);
    }
    for (const [mesh, p] of [
      [actual.current, d.actualTcp],
      [setpoint.current, d.setpointTcp],
    ] as const) {
      if (!mesh) continue;
      mesh.visible = showTcp && p !== null;
      if (p) mesh.position.set(...p);
    }
  });

  const armColor = selected ? SELECT_COLOR : "#cfd8dc";
  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect({ kind: "component", id });
  };
  return (
    <group>
      <group ref={base}>
        <mesh onClick={select}>
          <cylinderGeometry args={[0.25, 0.25, 0.06, 6]} />
          <meshStandardMaterial color={selected ? "#6d6a3a" : "#5b6573"} />
        </mesh>
        <Html position={[0, 0.12, 0]} className="label" zIndexRange={[10, 0]}>
          {name}
        </Html>
      </group>
      {[0, 1, 2].map((i) => (
        <group key={i}>
          <mesh ref={(m) => (upper.current[i] = m)} onClick={select}>
            <cylinderGeometry args={[0.02, 0.02, 1, 12]} />
            <meshStandardMaterial color={armColor} />
          </mesh>
          <mesh ref={(m) => (lower.current[i] = m)} onClick={select}>
            <cylinderGeometry args={[0.008, 0.008, 1, 8]} />
            <meshStandardMaterial color={armColor} />
          </mesh>
        </group>
      ))}
      <group ref={effector}>
        <mesh onClick={select}>
          <cylinderGeometry args={[0.06, 0.06, 0.02, 6]} />
          <meshStandardMaterial color="#90a4ae" />
        </mesh>
        {/* Marks the 4th-axis orientation (local +X). */}
        <mesh position={[0.06, 0, 0]}>
          <boxGeometry args={[0.05, 0.01, 0.01]} />
          <meshStandardMaterial color="#ff7043" />
        </mesh>
      </group>
      <mesh ref={actual}>
        <sphereGeometry args={[0.015, 16, 16]} />
        <meshBasicMaterial color="#ff4081" depthTest={false} transparent />
      </mesh>
      <mesh ref={setpoint}>
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
