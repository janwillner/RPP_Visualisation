import * as THREE from "three";
import { Line } from "@react-three/drei";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { OVERLAY, PRODUCT, SOLID, STATUS } from "../../palette";
import type { ProductDisplay, SceneConveyor, SceneProduct } from "../scene-model";
import type { SourceFrame } from "../scene-frame";
import type { ProductGroup } from "../product-groups";
import type { ProductState } from "@rpp/protocol";
import type { LocalSelection } from "../SceneView";
import { applyTransform, EdgeLines, noRaycast, SELECT_COLOR } from "./common";

/** The meshes a conveyor adds besides its belt: its axis and its products, instanced on the belt or single. */

/** Height of the conveyor axis above the belt surface, so the line does not flicker against the belt. */
const AXIS_LIFT = 0.004;

/** Conveyor axis: radius of the origin ball, and radius and length of the direction arrow (m). */
const AXIS_BALL = 0.01;

const AXIS_ARROW = { radius: 0.015, length: 0.045 };

/** The ball is small; this invisible sphere around it is what a click or tap has to hit. */
const AXIS_HIT_RADIUS = 0.03;

/**
 * A conveyor's X axis on the belt, in its frame, as a violet overlay: a small ball at its shifted origin, a line
 * along the axis and a small conveying direction arrow at the belt end. The ball selects the conveyor, also one
 * without a body. Renderer local axes: belt X -> x, belt Y -> −z.
 */
export function ConveyorAxis(props: { conveyor: SceneConveyor; selected: boolean; onSelect: () => void }) {
  const { conveyor: c, selected, onSelect } = props;
  const z = -c.axis.originY;
  const color = selected ? SELECT_COLOR : OVERLAY.conveyorAxis;
  return (
    <>
      <mesh position={[c.axis.originX, AXIS_LIFT, z]} raycast={noRaycast}>
        <sphereGeometry args={[AXIS_BALL, 16, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <mesh
        position={[c.axis.originX, AXIS_LIFT, z]}
        userData={{ label: c.name }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        <sphereGeometry args={[AXIS_HIT_RADIUS, 12, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Line
        points={[
          [c.axis.originX, AXIS_LIFT, z],
          [c.length, AXIS_LIFT, z],
        ]}
        color={color}
        lineWidth={2}
        toneMapped={false}
        raycast={noRaycast}
      />
      <mesh
        position={[c.length + AXIS_ARROW.length / 2, AXIS_LIFT, z]}
        rotation={[0, 0, -Math.PI / 2]}
        raycast={noRaycast}
      >
        <coneGeometry args={[AXIS_ARROW.radius, AXIS_ARROW.length, 16]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </>
  );
}

const PRODUCT_COLORS: Record<ProductState, string> = PRODUCT;

const MISSED_COLOR = STATUS.missed;

/** Segments of a round product's outline: smooth enough up close, cheap for many products. */
export const ROUND_SEGMENTS = 40;

/**
 * A product's solid, centred, with local +X along its length, +Y up and +Z across (metres): a box, an (oval)
 * cylinder whose length and width are its diameters, or a box with rounded vertical edges.
 */
function productGeometry(p: SceneProduct): THREE.BufferGeometry {
  const { length, width, height } = p.size;
  if (p.shape === "cylinder") {
    const cylinder = new THREE.CylinderGeometry(0.5, 0.5, height, ROUND_SEGMENTS);
    cylinder.scale(length, 1, width);
    return cylinder;
  }
  const r = Math.min(p.cornerRadius, length / 2, width / 2);
  if (p.shape === "roundedBox" && r > 0) {
    // Outline in the shape's (x, y) plane, extruded along its z: turned so that z becomes up and y becomes −Z.
    const x = length / 2 - r;
    const y = width / 2 - r;
    const outline = new THREE.Shape();
    outline.absarc(x, y, r, 0, Math.PI / 2, false);
    outline.absarc(-x, y, r, Math.PI / 2, Math.PI, false);
    outline.absarc(-x, -y, r, Math.PI, (3 * Math.PI) / 2, false);
    outline.absarc(x, -y, r, (3 * Math.PI) / 2, 2 * Math.PI, false);
    const solid = new THREE.ExtrudeGeometry(outline, { depth: height, bevelEnabled: false, curveSegments: 6 });
    solid.rotateX(-Math.PI / 2);
    solid.translate(0, -height / 2, 0);
    return solid;
  }
  return new THREE.BoxGeometry(length, height, width);
}

export const ONE = new THREE.Vector3(1, 1, 1);

const PRODUCT_COLOR_OBJECTS = Object.fromEntries(
  Object.entries(PRODUCT_COLORS).map(([state, color]) => [state, new THREE.Color(color)]),
) as Record<ProductState, THREE.Color>;

const SELECT_COLOR_OBJECT = new THREE.Color(SELECT_COLOR);

const MISSED_COLOR_OBJECT = new THREE.Color(MISSED_COLOR);

/**
 * One group of products as one instanced mesh, with their edge lines as one instanced line set sharing its instance
 * matrices: thousands of products cost a few draw calls instead of two each. Positions and colours are written every
 * frame; React renders it again only when the group needs more room.
 */
export function ProductInstances(props: {
  group: ProductGroup;
  frame: SourceFrame;
  selected: { conveyorId: number; productId: number } | undefined;
  onSelect: (s: LocalSelection) => void;
}) {
  const { group, frame, selected, onSelect } = props;
  const { sample, capacity } = group;
  const mesh = useRef<THREE.InstancedMesh>(null);
  /** The products drawn this frame, by instance index, for picking. */
  const drawn = useRef<SceneProduct[]>([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geometry = useMemo(() => productGeometry(sample), [group.key]);
  // The edges of one solid, drawn once per instance through the mesh's instance matrices (set once the mesh exists).
  const edges = useMemo(() => {
    const solidEdges = new THREE.EdgesGeometry(geometry, 30);
    const instanced = new THREE.InstancedBufferGeometry();
    instanced.setAttribute("position", solidEdges.getAttribute("position"));
    instanced.instanceCount = 0;
    return instanced;
  }, [geometry]);
  useEffect(
    () => () => {
      geometry.dispose();
      edges.dispose();
    },
    [geometry, edges],
  );
  // Like the edges of every solid part, but placed per instance: three.js adds the instance matrix to any material
  // that defines USE_INSTANCING, and draws an InstancedBufferGeometry once per instance, lines too.
  const edgeMaterial = useMemo(() => {
    const material = new THREE.LineBasicMaterial({ color: SOLID.edge, transparent: true, opacity: 0.55 });
    Object.assign(material, { defines: { USE_INSTANCING: "" } });
    return material;
  }, []);
  useEffect(() => () => edgeMaterial.dispose(), [edgeMaterial]);
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const position = useMemo(() => new THREE.Vector3(), []);
  const quaternion = useMemo(() => new THREE.Quaternion(), []);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const list = frame.members.get(group.key) ?? [];
    const n = Math.min(list.length, capacity);
    for (let i = 0; i < n; i++) {
      const p = list[i]!;
      position.set(...p.transform.position);
      quaternion.set(...p.transform.quaternion);
      m.setMatrixAt(i, matrix.compose(position, quaternion, ONE));
      const isSelected = selected?.conveyorId === p.conveyorId && selected.productId === p.productId;
      m.setColorAt(
        i,
        isSelected ? SELECT_COLOR_OBJECT : p.display === "missed" ? MISSED_COLOR_OBJECT : PRODUCT_COLOR_OBJECTS[p.state],
      );
    }
    m.count = n;
    edges.instanceCount = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    // Picking computes them again from the instances, which move.
    m.boundingSphere = null;
    m.boundingBox = null;
    drawn.current = list;
  });

  return (
    <>
      <instancedMesh
        ref={(m: THREE.InstancedMesh | null) => {
          mesh.current = m;
          if (m) edges.setAttribute("instanceMatrix", m.instanceMatrix);
        }}
        args={[geometry, undefined, capacity]}
        count={0}
        frustumCulled={false}
        userData={{ label: "Product" }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          const p = e.instanceId === undefined ? undefined : drawn.current[e.instanceId];
          if (!p) return;
          e.stopPropagation();
          onSelect({ kind: "product", conveyorId: p.conveyorId, productId: p.productId });
        }}
      >
        <meshStandardMaterial
          color="#fff"
          emissive={sample.display === "missed" ? MISSED_COLOR : "#000"}
          emissiveIntensity={0.4}
          roughness={0.6}
        />
      </instancedMesh>
      <lineSegments geometry={edges} material={edgeMaterial} frustumCulled={false} raycast={noRaycast} />
    </>
  );
}

export function ProductMesh(props: {
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
  const { shape, cornerRadius, size } = product;
  const geometry = useMemo(
    () => productGeometry(product),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shape, cornerRadius, size.length, size.width, size.height],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
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
        // Where the picked product lay: its outline only, unlit like the other overlays; the hidden fill keeps it
        // clickable.
        <>
          <meshBasicMaterial visible={false} />
          <EdgeLines geometry={geometry} color={color} />
        </>
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
