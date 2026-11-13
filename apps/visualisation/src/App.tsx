import { useEffect, useMemo, useRef, useState } from "react";
import type { ProductMark } from "@rpp/protocol";
import {
  ComponentTree,
  Inspector,
  MARK,
  markName,
  type CameraPose,
  type CameraPreset,
  type ConnectionSnapshot,
  defaultGatewayUrl,
  formatPointCopy,
  GatewayConnection,
  LayerToggles,
  type Layers,
  type MachineScene,
  measureChain,
  type MeasurePoint,
  offlineSources,
  pointsCsv,
  PRODUCT,
  SidePanelControls,
  sidePanelsLayout,
  SceneView,
  type Selection,
  type SnapPoint,
  sourceScene,
  type SourcedFaults,
  STATUS,
  StatusBar,
  TopBar,
  useSidePanel,
  useStore,
  useTick,
  type Vec3,
  ViewControls,
} from "@rpp/machine-view";
import { LiveMachine } from "./live-machine";
import {
  PlayerBar,
  PlayerBarToggle,
  RecordButton,
  ReplayButton,
  usePlaybackKeys,
  useRecordingControls,
} from "./RecordingControls";
import { Viewer } from "./viewer";
import { loadViewSettings, saveViewSettings, type ViewSettings } from "./view-settings";

/** `?embedded`: the page is a frame inside the machine HMI, which has its own header; title and status bar go. */
const EMBEDDED = new URLSearchParams(window.location.search).has("embedded");
/** The clipboard exists only in a secure context (https or localhost), not when embedded over http. */
const CAN_COPY = window.isSecureContext && navigator.clipboard !== undefined;
/** From this window width the components panel starts open; below, the 3D view gets the room. */
const WIDE_SCREEN_PX = 1600;

export function App() {
  const store = useMemo(() => new GatewayConnection(defaultGatewayUrl()), []);
  // Live or a recording; it keeps the replay buffer from now on (ADR 0011).
  const viewer = useMemo(
    () => new Viewer(new LiveMachine(store), () => window.confirm("Discard the current recording? It has not been saved.")),
    [store],
  );
  useEffect(() => {
    viewer.start();
    store.start();
    return () => {
      store.stop();
      viewer.stop();
    };
  }, [store, viewer]);
  const gateway = useStore(store);
  // Layers, hidden components and camera come back as they were left on this device.
  const initialView = useMemo(loadViewSettings, []);
  const view = useRef<ViewSettings>(initialView);
  const [layers, setLayers] = useState<Layers>(initialView.layers);
  const [faults, setFaults] = useState<SourcedFaults[]>([]);
  const [selection, setSelection] = useState<Selection>();
  // Component keys, and source ids for whole sources.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(initialView.hidden));
  useEffect(() => {
    view.current = { ...view.current, layers, hidden: [...hidden] };
    saveViewSettings(view.current);
  }, [layers, hidden]);
  const rememberCamera = (camera: CameraPose) => {
    view.current = { ...view.current, camera };
    saveViewSettings(view.current);
  };
  const toggleHidden = (key: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const [cameraRequest, setCameraRequest] = useState<{ action: CameraPreset; seq: number }>({ action: "iso", seq: 0 });
  const left = useSidePanel("rpp.panel.components", "Components", () => window.innerWidth >= WIDE_SCREEN_PX);
  // The inspector starts closed: the 3D view gets the room until someone wants the details.
  const right = useSidePanel("rpp.panel.inspector", "Inspector", () => false);
  const panels = sidePanelsLayout(left, right);
  const modelRef = useRef<MachineScene | undefined>(undefined);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  const nextPointId = useRef(1);
  // Frozen at the moment of the click: later state or config changes do not move a measuring point.
  const addMeasurePoint = (p: SnapPoint) =>
    setMeasurePoints((points) => [
      ...points,
      { id: nextPointId.current++, label: p.label, mcs: p.mcs, position: p.position, local: p.local },
    ]);
  const clearMeasurePoints = () => {
    setMeasurePoints([]);
    nextPointId.current = 1;
  };

  // M toggles measure mode, Esc leaves it (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "m" || e.key === "M") setMeasureMode((m) => !m);
      else if (e.key === "Escape") setMeasureMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const recording = useRecordingControls(viewer);
  usePlaybackKeys(recording);
  // While playing back, the tree, the 3D view and the inspector show the recording instead of the live data.
  const playback = recording.mode === "playback";

  const camera = (action: CameraPreset) => setCameraRequest((r) => ({ action, seq: r.seq + 1 }));
  const toggle = (key: keyof Layers) => setLayers((l) => ({ ...l, [key]: !l[key] }));
  const appClass = ["app", EMBEDDED && "embedded", panels.className].filter(Boolean).join(" ");

  return (
    // A long press on a touch screen opens no context menu: the app has no secondary actions.
    <div
      className={appClass}
      style={panels.style}
      onContextMenu={(e) => {
        if ((e.nativeEvent as PointerEvent).pointerType === "touch") e.preventDefault();
      }}
    >
      <TopBar title={EMBEDDED ? undefined : "RPP Visualisation"}>
        <LayerToggles layers={layers} onToggle={toggle} />
      </TopBar>
      <aside className="panel left" hidden={!left.open}>
        <ComponentTree
          sources={recording.sources}
          selection={selection}
          onSelect={setSelection}
          hidden={hidden}
          onToggleHidden={toggleHidden}
          faults={faults}
        />
      </aside>
      {/* No context menu on a long press: there are no secondary actions in the 3D view. */}
      <main
        className={["viewport", playback && "playback", !recording.recorder && recording.barOpen && "has-player"]
          .filter(Boolean)
          .join(" ")}
        onContextMenu={(e) => e.preventDefault()}
      >
        <SceneView
          frame={(now) => viewer.frame(now)}
          layers={layers}
          selection={selection}
          onSelect={setSelection}
          cameraRequest={cameraRequest}
          initialCamera={initialView.camera}
          onCameraChange={rememberCamera}
          modelRef={modelRef}
          measureMode={measureMode}
          onMeasure={addMeasurePoint}
          measurePoints={measurePoints}
          hidden={hidden}
          onFaults={setFaults}
        />
        <SidePanelControls left={left} right={right} />
        <ViewControls onCamera={camera} />
        <MeasureButton on={measureMode} onClick={() => setMeasureMode((m) => !m)} />
        <ReplayButton controls={recording} />
        <RecordButton controls={recording} />
        <PlayerBarToggle controls={recording} />
        <PlayerBar controls={recording} />
        {playback && <div className="playback-banner">Playback</div>}
        {recording.notice && (
          <div className="recording-notice" role="status">
            {recording.notice}
            <button className="link" aria-label="Close" onClick={() => viewer.dismissNotice()}>
              ×
            </button>
          </div>
        )}
        {EMBEDDED && !playback && <OfflineNotice gateway={gateway} />}
        {(measureMode || measurePoints.length > 0) && (
          <MeasureList
            measureMode={measureMode}
            points={measurePoints}
            onClear={clearMeasurePoints}
            onDone={() => setMeasureMode(false)}
          />
        )}
        {!measureMode && selection?.kind === "product" && (
          <ProductLegend
            selection={selection}
            modelRef={modelRef}
            marks={recording.sources.find((s) => s.sourceId === selection.sourceId)?.config?.marks}
            showMarks={layers.marks}
            onClose={() => setSelection(undefined)}
          />
        )}
      </main>
      <aside className="panel right" hidden={!right.open}>
        <Inspector
          feed={viewer}
          sources={recording.sources}
          selection={selection}
          modelRef={modelRef}
          faults={faults}
        />
      </aside>
      {!EMBEDDED && <StatusBar store={store} gateway={gateway} modelRef={modelRef} />}
    </div>
  );
}

/** Embedded there is no status bar: a red note in the 3D view tells that (part of) the machine is not live. */
function OfflineNotice({ gateway }: { gateway: ConnectionSnapshot }) {
  const offline = offlineSources(gateway);
  if (gateway.socket === "open" && offline.length === 0) return null;
  const text =
    gateway.socket !== "open"
      ? "Gateway not connected"
      : gateway.sources.length === 1
        ? "PLC not connected"
        : `PLC offline: ${offline.map((s) => s.name).join(", ")}`;
  return (
    <div className="offline-notice" role="status">
      {text}
    </div>
  );
}

/** Measure mode on / off, bottom right in the 3D view; the key M does the same. */
function MeasureButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      className={on ? "measure-toggle toggle on" : "measure-toggle toggle"}
      title={on ? "Leave measure mode (M)" : "Measure (M)"}
      aria-label="Measure"
      aria-pressed={on}
      onClick={onClick}
    >
      <RulerIcon />
    </button>
  );
}

/** A ruler lying diagonally, with its scale marks. */
function RulerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="1.5" y="8" width="21" height="8" rx="1" transform="rotate(-45 12 12)" />
      <g transform="rotate(-45 12 12)" strokeLinecap="round">
        <line x1="5" y1="8" x2="5" y2="11" />
        <line x1="8.5" y1="8" x2="8.5" y2="12.5" />
        <line x1="12" y1="8" x2="12" y2="11" />
        <line x1="15.5" y1="8" x2="15.5" y2="12.5" />
        <line x1="19" y1="8" x2="19" y2="11" />
      </g>
    </svg>
  );
}

const fmt = (p: Vec3) => p.map((v) => v.toFixed(1)).join(" / ");

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/**
 * Measuring points as a chain: MCS coordinates, the same point in its component's frame, and the offsets along
 * X, Y and Z from the previous point. Where the clipboard is available, a click on a row copies "X;Y;Z".
 */
function MeasureList(props: { measureMode: boolean; points: MeasurePoint[]; onClear: () => void; onDone: () => void }) {
  const { measureMode, points, onClear, onDone } = props;
  const chain = measureChain(points.map((p) => p.mcs));
  return (
    <div className="measure">
      {measureMode && (
        <div className="measure-hint">
          <span className="muted">Measure mode · click or tap a snap point to add it</span>
          <button onClick={onDone}>Done</button>
        </div>
      )}
      {points.length > 0 && (
        <>
          <ol className="measure-points">
            {points.map((p, i) => {
              const link = chain[i]!;
              const Row = CAN_COPY ? "button" : "div";
              return (
                <li key={p.id}>
                  <Row
                    className="measure-row"
                    {...(CAN_COPY ? { onClick: () => copy(formatPointCopy(p.mcs)), title: "Copy X;Y;Z" } : {})}
                  >
                    <span className="measure-head">
                      <strong>#{p.id}</strong> <span className="muted">{p.label}</span>
                    </span>
                    <span className="measure-mcs">
                      MCS <strong>{fmt(p.mcs)}</strong> mm
                    </span>
                    <span className="muted">
                      {p.local.componentName} local {fmt(p.local.point)}
                    </span>
                    {link.delta && (
                      <span className="measure-delta">
                        ΔX <strong>{link.delta[0].toFixed(1)}</strong> · ΔY <strong>{link.delta[1].toFixed(1)}</strong>
                        {" · "}ΔZ <strong>{link.delta[2].toFixed(1)}</strong> mm
                      </span>
                    )}
                  </Row>
                </li>
              );
            })}
          </ol>
          <div className="measure-actions">
            {CAN_COPY && (
              <button className="link" onClick={() => copy(pointsCsv(points))}>
                Copy all as CSV
              </button>
            )}
            <button className="link muted" onClick={onClear}>
              Clear points
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Colour legend, shown only while a product is selected (the selected product itself is drawn in the
 * selection colour). The entry matching the selected product is highlighted.
 */
function ProductLegend(props: {
  selection: { kind: "product"; sourceId: string; conveyorId: number; productId: number };
  modelRef: React.RefObject<MachineScene | undefined>;
  /** The selected product's source's named marks. */
  marks: readonly ProductMark[] | undefined;
  /** Layer "Product marks": a marked product shows its mark. */
  showMarks: boolean;
  onClose: () => void;
}) {
  const { selection, modelRef, marks, showMarks, onClose } = props;
  useTick(200);
  const matches =
    sourceScene(modelRef, selection.sourceId)?.products.filter(
      (p) => p.conveyorId === selection.conveyorId && p.productId === selection.productId,
    ) ?? [];
  const product = matches.find((p) => p.display !== "placeholder") ?? matches[0];
  const current = product ? (product.display === "missed" ? "missed" : product.state) : undefined;
  const hasPlaceholder = matches.some((p) => p.display === "placeholder");
  const entries: { key: string; color?: string; outline?: boolean; active: boolean }[] = [
    ...Object.entries(PRODUCT).map(([state, color]) => ({ key: state, color, active: state === current })),
    { key: "missed", color: STATUS.missed, active: current === "missed" },
    { key: "placeholder", outline: true, active: hasPlaceholder },
    // Its mark, which it shows instead of its state colour while marks are shown.
    ...(product && product.mark > 0
      ? [{ key: `mark: ${markName(marks, product.mark)}`, color: MARK[product.mark - 1], active: showMarks }]
      : []),
  ];
  return (
    <div className="product-legend" role="dialog" aria-label="Product colours">
      <div className="product-legend-head">
        <strong>Product #{selection.productId}</strong>
        <span className="muted"> · conveyor #{selection.conveyorId}</span>
        <button className="link" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <ul className="legend">
        {entries.map((e) => (
          <li key={e.key} className={e.active ? "active" : ""}>
            <i className={e.outline ? "outline" : ""} style={e.color ? { background: e.color } : undefined} /> {e.key}
          </li>
        ))}
      </ul>
      {!product && <p className="muted">No longer in the register.</p>}
    </div>
  );
}

