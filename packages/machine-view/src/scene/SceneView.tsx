import * as THREE from "three";
import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Fragment,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { AXES, OVERLAY, SOLID, STAGE } from "../palette";
import {
  availableSnapPoints,
  buildMachineScene,
  emptyScene,
  type MachineScene,
  type SceneAllocation,
  type SceneBoxArea,
  type SceneConveyor,
  type SceneDelta,
  type SceneFaultLabel,
  type SceneFinger,
  type SceneModel,
  type SceneOrigin,
  type SceneSource,
  type SceneZone,
  type SnapPoint,
  type SourcedFaults,
  type Transform,
  type Vec3,
} from "./scene-model";
import { MachineFrame, SourceFrame } from "./scene-frame";
import { pickOnScreen, type PointerSample, PressTracker, type Projection, type ScreenPoint } from "./picking";
import { isGrouped } from "./product-groups";
import type { ConfigMessage } from "@rpp/protocol";
import {
  applyTransform,
  FAULT_COLOR,
  FaultScope,
  noRaycast,
  Outline,
  OVERLAY_ORDER,
  OverlayMaterial,
  placeBetween,
  rectangle,
  SELECT_COLOR,
  showFault,
  SolidBox,
  useBox,
} from "./views/common";
import { ConveyorAxis, ProductInstances, ProductMesh } from "./views/conveyor";
import { DeltaMesh, WorkingAreaMesh } from "./views/delta";
import { GantryMesh, LoopMesh } from "./views/xts";
import { CartesianMesh } from "./views/cartesian";
import { BodyMesh } from "./views/body";

export interface Layers {
  workingAreas: boolean;
  limitAreas: boolean;
  zones: boolean;
  tcpMarkers: boolean;
  faultLabels: boolean;
  /** Every component's coordinate system: an axis triad where its origin shift puts it (always shown while measuring). */
  origins: boolean;
  /** Product marks: a product the PLC marked shows its mark's colour instead of its state colour. */
  marks: boolean;
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

/** A camera pose in renderer coordinates (m, Y up): where it is and the point it orbits around. */
export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

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
  /**
   * Every source as the machine scene takes it, at `now` (performance.now()), each drawn on its own; called once per
   * drawn frame. The live gateway, a recording being played back or a draft.
   */
  frame: (now?: number) => SceneSource[];
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
  /** Called whenever the set of active faults changes (hidden components included). */
  onFaults: (faults: SourcedFaults[]) => void;
  /** Drawn inside the 3D view, e.g. the configurator's handles; they may use the canvas, camera and controls. */
  children?: ReactNode;
}

const EMPTY: SceneModel = emptyScene();

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
  useLayoutEffect(() => {
    fade(ref.current, offline);
  });
  return <group ref={ref}>{children}</group>;
}

/**
 * A fault message hanging above its component or mover, or a limit violation above its TCP limit area (in its own
 * look: not a fault the PLC reports); follows a moving mover or TCP.
 */
function FaultLabel({ label, frame }: { label: SceneFaultLabel; frame: SourceFrame }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const live = frame.part("faultLabels", label.key);
    if (live) group.current?.position.set(...live.position);
  });
  return (
    <group ref={group} position={label.position}>
      <Html
        center
        className={label.limit ? "fault-label limit" : "fault-label"}
        zIndexRange={[25, 15]}
        style={{ pointerEvents: "none" }}
      >
        {label.message}
      </Html>
    </group>
  );
}

const EMPTY_MACHINE: MachineScene = { sources: [], snapPoints: [], origins: [], faults: [] };

/** A source as the view draws it: its group exists while it does, rebuilt for every new config. */
interface DrawnSource {
  sourceId: string;
  config: ConfigMessage | undefined;
}

const sameSources = (drawn: readonly DrawnSource[], now: readonly SceneSource[]) =>
  drawn.length === now.length && drawn.every((d, i) => d.sourceId === now[i]!.sourceId && d.config === now[i]!.config);

function SceneContent(props: SceneViewProps) {
  const { frame, layers, selection, modelRef, measureMode, onMeasure, measurePoints, hidden, onFaults } = props;
  // In measure mode a click measures; selecting works only through the component tree.
  const onSelect = measureMode ? () => {} : props.onSelect;
  const machine = useMemo(() => new MachineFrame(), []);
  const [structure, setStructure] = useState<MachineScene>(EMPTY_MACHINE);
  // The sources drawn and their configs: re-rendered only when one comes, goes or gets a new config.
  const [sources, setSources] = useState<readonly DrawnSource[]>([]);
  const drawn = useRef(sources);

  // Priority −1: runs before the sources' frame callbacks, which read the scene built here.
  useFrame(() => {
    const now = frame();
    if (!sameSources(drawn.current, now)) {
      drawn.current = now.map(({ sourceId, config }) => ({ sourceId, config }));
      setSources(drawn.current);
    }
    // Products get snap points only while measuring: with thousands of products they cost most of the frame.
    const model = buildMachineScene(now, hidden, { measureSnapPoints: measureMode });
    modelRef.current = model;
    const changes = machine.next(model);
    if (changes.structure) setStructure(model);
    if (changes.faults) onFaults(model.faults);
  }, -1);

  const bounds = useMemo(() => boundsOf(structure), [structure]);

  return (
    <>
      <McsAxes />
      <MeasurePoints points={measurePoints} />
      {(layers.origins || measureMode) && <OriginTriads machine={machine} structure={structure} />}
      {measureMode && <MeasureLayer machine={machine} structure={structure} layers={layers} onMeasure={onMeasure} />}
      <Stage bounds={bounds} />
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
        // Where the parts are now: a pose may change without changing the structure (the configurator moves them).
        current={() => modelRef.current && boundsOf(modelRef.current)}
        initial={props.initialCamera}
        onChange={props.onCameraChange}
      />
    </>
  );
}

/** What the view of one kind of scene part draws from. */
interface PartViewContext {
  /** The scene as of the last structural change: which objects exist. */
  structure: SceneModel;
  /** The scene of this frame: where they are now. */
  frame: SourceFrame;
  layers: Layers;
  selection: LocalSelection;
  isSelected(componentId: number): boolean;
  onSelect(selection: LocalSelection): void;
}

/**
 * How every kind of scene part is drawn, in drawing order. Null for the kinds drawn across sources (snap points,
 * origins) or not drawn at all; a new kind in `SceneModel` has to be listed here.
 */
const PART_VIEWS: { [K in keyof SceneModel]: ((v: PartViewContext) => ReactNode) | null } = {
  conveyors: ({ structure, isSelected, onSelect }) =>
    structure.conveyors.map((c) => (
      <group key={c.id} ref={(o) => applyTransform(o, c.transform)}>
        <FaultScope faulted={c.fault !== null}>
          {c.body && (
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
          )}
          <ConveyorAxis conveyor={c} selected={isSelected(c.id)} onSelect={() => onSelect({ kind: "component", id: c.id })} />
        </FaultScope>
        <Html position={[0, 0.06, -c.width / 2]} className="label" zIndexRange={[10, 0]}>
          {c.name}
        </Html>
      </group>
    )),
  products: ({ structure, frame, layers, selection, onSelect }) => (
    <>
      {frame.productGroups.map((g) => (
        <ProductInstances
          key={`${g.key}:${g.capacity}`}
          group={g}
          frame={frame}
          selected={selection?.kind === "product" ? selection : undefined}
          marks={layers.marks}
          onSelect={onSelect}
        />
      ))}
      {structure.products
        .filter((p) => !isGrouped(p))
        .map((p) => (
          <ProductMesh
            key={p.key}
            product={p}
            selected={selection?.kind === "product" && selection.conveyorId === p.conveyorId && selection.productId === p.productId}
            marks={layers.marks}
            lookup={(key) => frame.single.get(key)}
            onSelect={onSelect}
          />
        ))}
    </>
  ),
  deltas: ({ structure, frame, layers, isSelected, onSelect }) =>
    structure.deltas.map((d) => (
      <DeltaMesh key={d.id} delta={d} frame={frame} showTcp={layers.tcpMarkers} selected={isSelected(d.id)} onSelect={onSelect} />
    )),
  gantries: ({ structure, frame, isSelected, onSelect }) =>
    structure.gantries.map((g) => (
      <GantryMesh key={g.id} gantry={g} frame={frame} selected={isSelected(g.id)} onSelect={onSelect} />
    )),
  loops: ({ structure, frame, isSelected, onSelect }) =>
    structure.loops.map((l) => <LoopMesh key={l.id} loop={l} frame={frame} selected={isSelected(l.id)} onSelect={onSelect} />),
  cartesians: ({ structure, frame, isSelected, onSelect }) =>
    structure.cartesians.map((c) => (
      <CartesianMesh key={c.id} robot={c} frame={frame} selected={isSelected(c.id)} onSelect={onSelect} />
    )),
  bodies: ({ structure, frame, layers, isSelected, onSelect }) =>
    structure.bodies.map((b) =>
      (b.role === "beam" || b.role === "fieldOfView") && !layers.zones ? null : (
        <BodyMesh key={b.key} body={b} frame={frame} selected={isSelected(b.componentId)} onSelect={onSelect} />
      ),
    ),
  fingers: ({ structure, frame, isSelected, onSelect }) =>
    structure.fingers.map((f) => (
      <FingerMesh key={f.key} finger={f} frame={frame} selected={isSelected(f.robotId)} onSelect={onSelect} />
    )),
  boxAreas: ({ structure, layers, isSelected }) =>
    layers.workingAreas &&
    structure.boxAreas.map((a) => (
      <BoxAreaMesh
        key={`box:${a.robotId}`}
        area={a}
        color={isSelected(a.robotId) ? SELECT_COLOR : OVERLAY.workingArea}
        fillOpacity={0.1}
      />
    )),
  // A violated box lights up red, even when selected: the warning matters more than the highlight.
  limitAreas: ({ structure, layers, isSelected }) =>
    layers.limitAreas &&
    structure.limitAreas.map((a) => (
      <BoxAreaMesh
        key={`limit:${a.robotId}`}
        area={a}
        color={limitAreaColor(a.violated, isSelected(a.robotId))}
        fillOpacity={a.violated ? VIOLATED_FILL : 0.06}
      />
    )),
  tcpLimitAreas: ({ structure, frame, layers, isSelected }) =>
    layers.limitAreas &&
    structure.tcpLimitAreas.map((a) => (
      <BoxAreaMesh
        key={`tcp:${a.key}`}
        area={a}
        color={limitAreaColor(a.violated, isSelected(a.robotId))}
        fillOpacity={a.violated ? VIOLATED_FILL : 0.03}
        follow={() => frame.part("tcpLimitAreas", a.key)?.transform}
      />
    )),
  workingAreas: ({ structure, layers, isSelected }) =>
    layers.workingAreas &&
    structure.workingAreas.map((w) => (
      <WorkingAreaMesh key={w.robotId} area={w} color={isSelected(w.robotId) ? SELECT_COLOR : OVERLAY.workingArea} />
    )),
  zones: ({ structure, layers, isSelected }) =>
    layers.zones && (
      <>
        {structure.zones.map((w, i) => (
          <group key={`${w.componentId}:${i}`} ref={(o) => applyTransform(o, w.transform)}>
            <mesh position={[0, 0.003, 0]} renderOrder={OVERLAY_ORDER} userData={{ label: `Zone (#${w.componentId})` }}>
              <boxGeometry args={[w.length, 0.004, w.width]} />
              <OverlayMaterial color={OVERLAY.zone} opacity={isSelected(w.componentId) ? 0.55 : 0.3} />
            </mesh>
            <Outline points={rectangle(w.length, w.width, 0.007)} color={isSelected(w.componentId) ? SELECT_COLOR : OVERLAY.zone} />
            {w.allocation && (
              <AllocationMesh allocation={w.allocation} zone={w} color={OVERLAY.allocation} selected={isSelected(w.componentId)} />
            )}
          </group>
        ))}
        {structure.zones.map((w, i) => (
          <CcsLine key={`ccs:${w.componentId}:${i}`} transform={w.ccs} width={w.width} />
        ))}
      </>
    ),
  faultLabels: ({ structure, frame, layers }) =>
    layers.faultLabels && structure.faultLabels.map((l) => <FaultLabel key={l.key} label={l} frame={frame} />),
  snapPoints: null,
  origins: null,
  faults: null,
  warnings: null,
};

/** Everything one PLC source draws, with its manifest ids; faded while the source is offline. */
function SourceContent(props: {
  sourceId: string;
  config: ConfigMessage | undefined;
  online: boolean;
  machine: MachineFrame;
  layers: Layers;
  hidden: ReadonlySet<string>;
  selection: LocalSelection;
  onSelect: (s: LocalSelection) => void;
}) {
  const { sourceId, config, online, machine, layers, hidden, selection, onSelect } = props;
  const frame = useMemo(() => new SourceFrame(), []);
  const [structure, setStructure] = useState<SceneModel>(EMPTY);
  // A new config can change geometry without changing ids: force a structural update.
  useEffect(() => frame.invalidate(), [frame, config, hidden]);

  // Priority -0.5: after the machine scene is built, before the parts' frame callbacks read what is taken here.
  useFrame(() => {
    const model = machine.source(sourceId) ?? EMPTY;
    if (frame.next(model)) setStructure(model);
  }, -0.5);

  const context: PartViewContext = {
    structure,
    frame,
    layers,
    selection,
    isSelected: (id) => selection?.kind === "component" && selection.id === id,
    onSelect,
  };

  return (
    <OfflineScope offline={!online}>
      {Object.entries(PART_VIEWS).map(([kind, view]) => view && <Fragment key={kind}>{view(context)}</Fragment>)}
    </OfflineScope>
  );
}

/**
 * A zone's conveyor coordinate system: a white dashed line lying on the belt, across the whole zone width. It lies
 * above every zone overlay (the allocation limit bar's top is 11 mm) and is drawn after them, so the limit bar cannot
 * hide it when both lie at the same belt coordinate. Renderer local axes: belt X -> x, belt Y -> −z.
 */
function CcsLine({ transform, width }: { transform: Transform; width: number }) {
  return (
    <group ref={(o) => applyTransform(o, transform)}>
      <Line
        points={[
          [0, 0.016, -width / 2],
          [0, 0.016, width / 2],
        ]}
        color={OVERLAY.ccs}
        lineWidth={2}
        dashed
        dashSize={0.03}
        gapSize={0.02}
        toneMapped={false}
        renderOrder={OVERLAY_ORDER + 1}
        raycast={noRaycast}
      />
    </group>
  );
}

/** Fill of a violated limit area or TCP limit area: it lights up. */
const VIOLATED_FILL = 0.18;

/** A limit area's or TCP limit area's colour: red while violated, whether selected or not. */
function limitAreaColor(violated: boolean, selected: boolean): string {
  return violated ? FAULT_COLOR : selected ? SELECT_COLOR : OVERLAY.limitArea;
}

/**
 * A box area (Cartesian working area, limit area, TCP limit area): see-through box with solid edges. With `follow` it
 * moves every frame to where that says, e.g. a TCP limit area with its TCP.
 */
function BoxAreaMesh(props: {
  area: SceneBoxArea;
  color: string;
  fillOpacity: number;
  follow?: () => Transform | undefined;
}) {
  const { area, color, fillOpacity, follow } = props;
  // Renderer local axes: MCS X -> x, MCS Z -> y, MCS Y -> −z.
  const geometry = useBox(area.size[0], area.size[2], area.size[1]);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry]);
  useEffect(() => () => edges.dispose(), [edges]);
  const group = useRef<THREE.Group | null>(null);
  useFrame(() => {
    if (follow) applyTransform(group.current, follow());
  });
  return (
    <group
      ref={(o) => {
        group.current = o;
        applyTransform(o, area.transform);
      }}
    >
      <mesh geometry={geometry} raycast={noRaycast} renderOrder={OVERLAY_ORDER}>
        <OverlayMaterial color={color} opacity={fillOpacity} doubleSided />
      </mesh>
      <lineSegments geometry={edges} raycast={noRaycast} renderOrder={OVERLAY_ORDER}>
        <lineBasicMaterial color={color} toneMapped={false} />
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
  frame: SourceFrame;
  selected: boolean;
  onSelect: (s: LocalSelection) => void;
}) {
  const { finger, frame, selected, onSelect } = props;
  const body = useRef<THREE.Group>(null);
  const rod = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    const live = frame.part("fingers", finger.key);
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
 * Every component's coordinate system as an axis triad. The triads exist per structure (which components there are);
 * where they stand is read from the scene of every frame, so a triad follows its component while it is dragged.
 */
function OriginTriads({ machine, structure }: { machine: MachineFrame; structure: MachineScene }) {
  const groups = useRef(new Map<string, THREE.Group>());
  useFrame(() => {
    for (const o of machine.scene.origins) applyTransform(groups.current.get(originKey(o)) ?? null, o.transform);
  });
  return (
    <>
      {structure.origins.map((o) => {
        const key = originKey(o);
        return (
          <OriginTriad
            key={key}
            origin={o}
            onGroup={(group) => (group ? groups.current.set(key, group) : groups.current.delete(key))}
          />
        );
      })}
    </>
  );
}

const originKey = (o: SceneOrigin & { sourceId: string }) => `${o.sourceId}:${o.componentId}`;

/**
 * Measure mode overlay: the static snap points as dots, and the snap point nearest to the
 * pointer (within the pointer type's snap radius on screen, also when occluded) highlighted with its name.
 * - Mouse and pen: the point under the hovering pointer is highlighted; a click without camera drag measures it.
 * - Touch: there is no hover. One finger shows the point under it (its name above the finger), sliding moves the
 *   choice, lifting the finger measures it. Two fingers move the camera and measure nothing.
 */
function MeasureLayer(props: {
  machine: MachineFrame;
  structure: MachineScene;
  layers: Layers;
  onMeasure: (point: SnapPoint) => void;
}) {
  const { machine, structure, layers, onMeasure } = props;
  const { camera, gl } = useThree();
  const pointer = useRef<(ScreenPoint & { type: string }) | null>(null);
  const marker = useRef<THREE.Group>(null);
  const [label, setLabel] = useState<{ text: string; touch: boolean } | null>(null);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  /** The snap point under a screen position, for the given pointer type's snap radius. */
  const pick = (at: ScreenPoint, pointerType: string): SnapPoint | undefined =>
    pickOnScreen(availableSnapPoints(machine.scene.snapPoints, layers), at, pointerType, projection(camera, gl.domElement));
  const pickRef = useRef(pick);
  pickRef.current = pick;

  useEffect(() => {
    const el = gl.domElement;
    // A finger may slide to adjust its choice; a mouse drag moves the camera instead.
    const presses = new PressTracker({ touchSlides: true, primaryOnly: true });
    const sample = (e: PointerEvent): PointerSample => {
      const r = el.getBoundingClientRect();
      return { pointerId: e.pointerId, pointerType: e.pointerType, button: e.button, x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      // A finger only points while it touches; with two fingers down the camera moves.
      if (e.pointerType === "touch" && (!presses.isDown(e.pointerId) || presses.pointers > 1)) return;
      const { x, y } = sample(e);
      pointer.current = { x, y, type: e.pointerType };
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "touch") pointer.current = null;
    };
    const onDown = (e: PointerEvent) => {
      const s = sample(e);
      presses.pointerDown(s);
      if (presses.pointers > 1) pointer.current = null;
      else if (e.button === 0) pointer.current = { x: s.x, y: s.y, type: e.pointerType };
    };
    const onUp = (e: PointerEvent) => {
      const at = presses.pointerUp(sample(e));
      if (e.pointerType === "touch") pointer.current = null;
      if (!at) return;
      // Picked at the release position, not from the last frame: a quick tap may start and end within one frame.
      const candidate = pickRef.current(at, e.pointerType);
      if (candidate) onMeasureRef.current(candidate);
    };
    const onCancel = (e: PointerEvent) => {
      presses.pointerCancel(e.pointerId);
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
function OriginTriad({ origin, onGroup }: { origin: SceneOrigin; onGroup: (group: THREE.Group | null) => void }) {
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
    <group
      ref={(o) => {
        applyTransform(o, origin.transform);
        onGroup(o);
      }}
    >
      {axes.map((a, i) => (
        <primitive key={i} object={a} />
      ))}
      <Html position={[0, -0.04, 0]} className="origin-label" zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        {origin.name} origin
      </Html>
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
  /** Every component's origin, so a machine of other kinds than conveyors and Deltas is framed too. */
  origins: SceneOrigin[];
}

/** The parts of a machine scene that give the machine its extent. */
function boundsOf(machine: MachineScene): MachineBounds {
  return {
    conveyors: machine.sources.flatMap((s) => s.scene.conveyors),
    deltas: machine.sources.flatMap((s) => s.scene.deltas),
    origins: machine.sources.flatMap((s) => s.scene.origins),
  };
}

/** The box around the machine in renderer coordinates; a 2 m cube at the origin while nothing is known. */
function machineBox(structure: MachineBounds): THREE.Box3 {
  const box = new THREE.Box3();
  for (const c of structure.conveyors) {
    box.expandByPoint(new THREE.Vector3(...c.transform.position));
    const end = new THREE.Vector3(c.length, 0, 0).applyQuaternion(new THREE.Quaternion(...c.transform.quaternion));
    box.expandByPoint(new THREE.Vector3(...c.transform.position).add(end));
  }
  for (const d of structure.deltas) {
    box.expandByPoint(new THREE.Vector3(...d.base.position));
    // Down to its effector, so a gripper at the TCP is in the view too.
    if (d.effector) box.expandByPoint(new THREE.Vector3(...d.effector.position));
  }
  for (const o of structure.origins) box.expandByPoint(new THREE.Vector3(...o.transform.position));
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
  return box;
}
/** Quiet time after the last camera movement before it is reported as the camera's new place. */
const CAMERA_SETTLE_MS = 400;

/** Frames the conveyors, Delta bases and effectors, and component origins of all sources. */
function CameraRig(props: {
  request: { action: CameraPreset; seq: number };
  structure: MachineBounds;
  /** The parts as they are in the latest frame, framed by a camera request; `structure` until the first frame. */
  current?: () => MachineBounds | undefined;
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
    const box = machineBox(props.current?.() ?? structure);
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

/**
 * Everything around the machine: a neutral studio light without any download (generated, so it works on IPCs
 * without internet), a key light from nearly above, the floor at MCS Z = 0 that fades into
 * the background, and the measuring grid on it. No shadows: they cost weak panel PCs too much for what they add.
 */
function Stage({ bounds }: { bounds: MachineBounds }) {
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
    // Nearly from above, so the tops of parts are the brightest faces.
    l.position.copy(centre).add(new THREE.Vector3(0.15, 1, 0.2).multiplyScalar(radius * 2));
    l.target.position.copy(centre);
    l.target.updateMatrixWorld();
  }, [centre, radius]);

  const floorRadius = radius * 1.6 + 4;
  return (
    <>
      <hemisphereLight args={["#dfe8f5", "#2a2f36", 0.55]} />
      <directionalLight ref={light} intensity={1.6} />
      {/* A little below the grid, so the grid lines are never hidden by the floor. */}
      <mesh position={[centre.x, -0.002, centre.z]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast} renderOrder={-1}>
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

/** Render resolution in device pixels per CSS pixel: 1, for weak panel PC graphics. */
const DPR = 1;

export function SceneView(props: SceneViewProps) {
  // The presses on the canvas: a selection counts only after a tap, not a camera drag or a pinch.
  const presses = useMemo(() => new PressTracker(), []);
  // Set when a tap ends; an object's click clears it again, otherwise the tap hit empty space.
  const emptyTap = useRef(false);
  const latestProps = useRef(props);
  latestProps.current = props;
  const onSelect = (selection: Selection) => {
    emptyTap.current = false;
    if (presses.lastWasTap) props.onSelect(selection);
  };

  // Releases are watched on the window: OrbitControls follows a drag on the document, so it may end outside the
  // canvas. A cancelled pointer (e.g. the browser took over the touch) makes the press no tap.
  useEffect(() => {
    const release = (e: PointerEvent, cancelled: boolean) => {
      if (cancelled) {
        presses.pointerCancel(e.pointerId);
        return;
      }
      if (!presses.pointerUp(clientSample(e))) return;
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
      dpr={DPR}
      // Neutral tone mapping keeps the palette colours of lit parts close to what they are.
      gl={{ toneMapping: THREE.NeutralToneMapping }}
      onPointerDown={(e) => presses.pointerDown(clientSample(e.nativeEvent))}
    >
      <SceneContent {...props} onSelect={onSelect} />
      {props.children}
      {/* One finger orbits, two pinch and pan; in measure mode one finger picks a point instead. */}
      <OrbitControls
        makeDefault
        touches={{ ONE: props.measureMode ? NO_TOUCH_ACTION : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
      />
    </Canvas>
  );
}

/** A pointer event in client coordinates. */
function clientSample(e: PointerEvent): PointerSample {
  return { pointerId: e.pointerId, pointerType: e.pointerType, button: e.button, x: e.clientX, y: e.clientY };
}

/** Where a renderer point lies on `canvas` through `camera`, and how far from the camera. */
function projection(camera: THREE.Camera, canvas: HTMLCanvasElement): Projection {
  const v = new THREE.Vector3();
  return (position) => {
    v.set(...position).project(camera);
    if (v.z < -1 || v.z > 1) return undefined;
    const screen = { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight };
    return { screen, depth: camera.position.distanceTo(new THREE.Vector3(...position)) };
  };
}

/** OrbitControls ignores a one-finger gesture whose action is none of THREE.TOUCH. */
const NO_TOUCH_ACTION = -1 as THREE.TOUCH;
