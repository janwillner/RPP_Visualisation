import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ComponentConfig, ComponentState } from "@rpp/protocol";
import {
  GatewayConnection,
  STALE_AFTER_MS,
  defaultGatewayUrl,
  useStore,
  type ConnectionSnapshot,
} from "./gateway-connection";
import { LiveMachine } from "./live-machine";
import { isOnline, type SourceInfo } from "./sources";
import {
  PlayerBar,
  PlayerBarToggle,
  RecordButton,
  ReplayButton,
  usePlaybackKeys,
  useRecordingControls,
} from "./RecordingControls";
import { Viewer, type SceneFeed } from "./viewer";
import {
  componentKey,
  formatPointCopy,
  measureChain,
  pointsCsv,
  type MachineScene,
  type SceneModel,
  type SnapPoint,
  type SourcedFaults,
  type Vec3,
} from "./scene/scene-model";
import { CLIENT_ACTIONS, METRICS_WINDOW_MS, metrics, type ClientMetrics, type MachineMetrics } from "./metrics";
import { stateRows } from "./state-rows";
import { loadViewSettings, saveViewSettings, type ViewSettings } from "./view-settings";
import { PRODUCT, STATUS } from "./palette";
import { APP_VERSION } from "./version";
import { ViewControls } from "./ViewControls";
import {
  SceneView,
  type CameraPose,
  type CameraPreset,
  type Layers,
  type MeasurePoint,
  type Selection,
} from "./scene/SceneView";

/** `?embedded`: the page is a frame inside the machine HMI, which has its own header; title and status bar go. */
const EMBEDDED = new URLSearchParams(window.location.search).has("embedded");
/** The clipboard exists only in a secure context (https or localhost), not when embedded over http. */
const CAN_COPY = window.isSecureContext && navigator.clipboard !== undefined;
/** From this window width the components panel starts open; below, the 3D view gets the room. */
const WIDE_SCREEN_PX = 1600;

/** Whether a side panel is open: remembered per device, else `initial`. */
function usePanelOpen(storageKey: string, initial: () => boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return stored === "1";
    } catch {
      // Storage may be blocked (private window, embedded frame): fall back to the width.
    }
    return initial();
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(storageKey, o ? "0" : "1");
      } catch {
        // Not remembered then; the panel still toggles.
      }
      return !o;
    });
  return [open, toggle];
}

/** Side panel width limits while dragging its edge, px. */
const PANEL_MIN_PX = 180;
const PANEL_MAX_SHARE = 0.45;

/** A side panel's width set by dragging, remembered per device; undefined keeps the stylesheet's width. */
function usePanelWidth(storageKey: string): [number | undefined, (px: number) => void] {
  const [width, setWidth] = useState<number | undefined>(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return stored > 0 ? stored : undefined;
    } catch {
      return undefined;
    }
  });
  const set = (px: number) => {
    const clamped = Math.round(Math.min(Math.max(px, PANEL_MIN_PX), window.innerWidth * PANEL_MAX_SHARE));
    setWidth(clamped);
    try {
      localStorage.setItem(storageKey, String(clamped));
    } catch {
      // Not remembered then; the width still applies.
    }
  };
  return [width, set];
}

function machineMetrics(feed: SceneFeed, sources: readonly SourceInfo[]): MachineMetrics {
  const { events, now, since } = feed.productEvents(METRICS_WINDOW_MS);
  return metrics(events, now, since, sources);
}

/** "last 60 s", or the shorter time covered so far. */
const windowText = (m: MachineMetrics) => `last ${Math.round(m.windowMs / 1000)} s`;
const rate = (perMin: number) => perMin.toFixed(1);

/** The machine's figures over the last minute, while nothing is selected. */
function MetricsOverview({ figures, sources }: { figures: MachineMetrics; sources: readonly SourceInfo[] }) {
  const named = (x: { sourceId: string; name: string }) => {
    const source = sources.length > 1 ? sources.find((s) => s.sourceId === x.sourceId) : undefined;
    return source ? `${source.name} · ${x.name}` : x.name;
  };
  if (figures.clients.length === 0 && figures.conveyors.length === 0) return null;
  return (
    <>
      <h3>Metrics, {windowText(figures)}</h3>
      <p>
        Picks <strong>{rate(figures.picksPerMin)}</strong>/min · Missed <strong>{figures.missed}</strong>
        {figures.missedShare !== undefined && ` (${(figures.missedShare * 100).toFixed(1)} %)`}
      </p>
      <table className="metrics">
        <tbody>
          {figures.clients.map((c) => (
            <tr key={`k${c.sourceId}|${c.clientId}`}>
              <td>{named(c)}</td>
              <td>{clientRates(c)}</td>
            </tr>
          ))}
          {figures.conveyors.map((c) => (
            <tr key={`c${c.sourceId}|${c.conveyorId}`}>
              <td>{named(c)}</td>
              <td>
                {rate(c.inPerMin)} in/min
                {c.missed > 0 && <span className="bad"> · {c.missed} missed</span>}
                {c.rejected > 0 && <span className="muted"> · {c.rejected} rejected</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** What a client did per minute, e.g. "30.0 picked/min · 30.0 placed/min". */
const clientRates = (c: ClientMetrics) =>
  CLIENT_ACTIONS.filter((a) => c.perMin[a] !== undefined)
    .map((a) => `${rate(c.perMin[a]!)} ${a}/min`)
    .join(" · ");

/** A selected client's (robot, detector, station) or conveyor's own figures over the last minute. */
function ComponentMetrics({ figures, sourceId, id }: { figures: MachineMetrics; sourceId: string; id: number }) {
  const client = figures.clients.find((c) => c.sourceId === sourceId && c.clientId === id);
  const conveyor = figures.conveyors.find((c) => c.sourceId === sourceId && c.conveyorId === id);
  if (!client && !conveyor) return null;
  return (
    <p>
      <span className="muted">{windowText(figures)}:</span>{" "}
      {client && <>{clientRates(client)}</>}
      {conveyor && (
        <>
          {rate(conveyor.inPerMin)} products in/min · {conveyor.missed} missed · {conveyor.rejected} rejected
        </>
      )}
    </p>
  );
}

/** How long ago, e.g. "3.2 s ago" or "2 min 05 s ago". */
function formatAgo(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)} s ago`;
  return `${Math.floor(s / 60)} min ${String(Math.floor(s % 60)).padStart(2, "0")} s ago`;
}

/** Re-render at a fixed rate, for panels that show live values. */
function useTick(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

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
  const [leftOpen, toggleLeft] = usePanelOpen("rpp.panel.components", () => window.innerWidth >= WIDE_SCREEN_PX);
  // The inspector starts closed: the 3D view gets the room until someone wants the details.
  const [rightOpen, toggleRight] = usePanelOpen("rpp.panel.inspector", () => false);
  const [leftWidth, setLeftWidth] = usePanelWidth("rpp.panel.components.width");
  const [rightWidth, setRightWidth] = usePanelWidth("rpp.panel.inspector.width");
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
  const appClass = ["app", EMBEDDED && "embedded", !leftOpen && "left-closed", !rightOpen && "right-closed"]
    .filter(Boolean)
    .join(" ");

  return (
    // A long press on a touch screen opens no context menu: the app has no secondary actions.
    <div
      className={appClass}
      style={
        {
          ...(leftOpen && leftWidth && { "--left": `${leftWidth}px` }),
          ...(rightOpen && rightWidth && { "--right": `${rightWidth}px` }),
        } as CSSProperties
      }
      onContextMenu={(e) => {
        if ((e.nativeEvent as PointerEvent).pointerType === "touch") e.preventDefault();
      }}
    >
      <header className="toolbar">
        {!EMBEDDED && <strong className="title">RPP Visualisation</strong>}
        <div className="group">
          <span className="muted">Layers</span>
          <Toggle label="Working areas" on={layers.workingAreas} onClick={() => toggle("workingAreas")} />
          <Toggle label="Limit areas" on={layers.limitAreas} onClick={() => toggle("limitAreas")} />
          <Toggle label="Zones" on={layers.zones} onClick={() => toggle("zones")} />
          <Toggle label="TCP markers" on={layers.tcpMarkers} onClick={() => toggle("tcpMarkers")} />
          <Toggle label="Fault labels" on={layers.faultLabels} onClick={() => toggle("faultLabels")} />
        </div>
      </header>
      <aside className="panel left" hidden={!leftOpen}>
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
        {leftOpen && <PanelEdge side="left" onResize={setLeftWidth} />}
        {rightOpen && <PanelEdge side="right" onResize={setRightWidth} />}
        <PanelHandle side="left" label="Components" open={leftOpen} onClick={toggleLeft} />
        <PanelHandle side="right" label="Inspector" open={rightOpen} onClick={toggleRight} />
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
          <ProductLegend selection={selection} modelRef={modelRef} onClose={() => setSelection(undefined)} />
        )}
      </main>
      <aside className="panel right" hidden={!rightOpen}>
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

/** Sources the gateway cannot read right now (all of them while the gateway connection is down). */
function offlineSources(gateway: ConnectionSnapshot): readonly SourceInfo[] {
  return gateway.sources.filter((s) => !isOnline(s));
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

/** The 3D view's edge next to an open side panel: dragging it sets the panel's width. */
function PanelEdge({ side, onResize }: { side: "left" | "right"; onResize: (px: number) => void }) {
  const drag = useRef<{ x: number; width: number }>(undefined);
  return (
    <div
      className={`panel-edge ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize the components panel" : "Resize the inspector"}
      onPointerDown={(e) => {
        const panel = document.querySelector(`.panel.${side}`);
        if (!panel) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width: panel.getBoundingClientRect().width };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = e.clientX - drag.current.x;
        onResize(drag.current.width + (side === "left" ? dx : -dx));
      }}
      onPointerUp={() => (drag.current = undefined)}
      onPointerCancel={() => (drag.current = undefined)}
    />
  );
}

/** A tab on the 3D view's edge that opens or closes the side panel next to it. */
function PanelHandle(props: { side: "left" | "right"; label: string; open: boolean; onClick: () => void }) {
  const { side, label, open, onClick } = props;
  // The chevron points where the panel goes: into the edge to close, out of it to open.
  const pointsLeft = (side === "left") === open;
  return (
    <button
      className={`panel-handle ${side}`}
      title={`${open ? "Hide" : "Show"} ${label.toLowerCase()}`}
      aria-label={`${open ? "Hide" : "Show"} ${label.toLowerCase()}`}
      aria-expanded={open}
      onClick={onClick}
    >
      <span aria-hidden>{pointsLeft ? "‹" : "›"}</span>
    </button>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button className={on ? "toggle on" : "toggle"} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

/**
 * Colour legend, shown only while a product is selected (the selected product itself is drawn in the
 * selection colour). The entry matching the selected product is highlighted.
 */
/** The scene of one source, by manifest ids. */
function sourceScene(modelRef: React.RefObject<MachineScene | undefined>, sourceId: string): SceneModel | undefined {
  return modelRef.current?.sources.find((s) => s.sourceId === sourceId)?.scene;
}

function ProductLegend(props: {
  selection: { kind: "product"; sourceId: string; conveyorId: number; productId: number };
  modelRef: React.RefObject<MachineScene | undefined>;
  onClose: () => void;
}) {
  const { selection, modelRef, onClose } = props;
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

/**
 * The components of every source. With more than one source they are grouped under the source's name, with its
 * online state and an eye for the whole source.
 */
function ComponentTree(props: {
  sources: readonly SourceInfo[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  hidden: ReadonlySet<string>;
  onToggleHidden: (key: string) => void;
  faults: SourcedFaults[];
}) {
  const { selection, onSelect, hidden, onToggleHidden, faults } = props;
  const grouped = props.sources.length > 1;
  // A source that never answered has no config and appears only in the status bar.
  const sources = props.sources.filter((s) => s.config !== undefined);
  const components = (source: SourceInfo) => (
    <ul className="tree">
      {(source.config?.components ?? []).map((c) => {
        const key = componentKey(source.sourceId, c.id);
        const isHidden = hidden.has(key) || hidden.has(source.sourceId);
        const entry = faults.find((f) => f.sourceId === source.sourceId && f.componentId === c.id);
        // A limit violation alone is a warning, not a fault: the component's name keeps its colour.
        const faulted = (entry?.messages.length ?? 0) > 0;
        return (
          <li key={key} className={[isHidden ? "hidden" : "", faulted ? "faulted" : ""].join(" ").trim()}>
            <VisibilityButton name={c.name} hidden={hidden.has(key)} onClick={() => onToggleHidden(key)} />
            <button
              className={
                selection?.kind === "component" && selection.sourceId === source.sourceId && selection.id === c.id
                  ? "selected"
                  : ""
              }
              onClick={() => onSelect({ kind: "component", sourceId: source.sourceId, id: c.id })}
            >
              {entry && (
                <span className="fault-icon" aria-label={faulted ? "Fault" : "Limit violation"}>
                  ⚠
                </span>
              )}
              <span className={`badge ${c.type}`}>{c.type}</span> {c.name} <span className="muted">#{c.id}</span>
            </button>
            {/* Visible, not a tooltip: a touch panel shows no tooltips. */}
            {entry && (
              <ul className="fault-lines">
                {entry.messages.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
                {entry.limitViolations.map((m, i) => (
                  <li key={`limit:${i}`} className="limit">
                    Limit: {m}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
  const empty = sources.every((s) => (s.config?.components.length ?? 0) === 0);
  return (
    <>
      <h2>Components</h2>
      {empty && !grouped && <p className="muted">No components discovered.</p>}
      {grouped ? (
        <ul className="sources">
          {sources.map((source) => {
            const online = isOnline(source);
            return (
              <li key={source.sourceId} className={hidden.has(source.sourceId) ? "hidden" : ""}>
                <div className="source-head">
                  <VisibilityButton
                    name={source.name}
                    hidden={hidden.has(source.sourceId)}
                    onClick={() => onToggleHidden(source.sourceId)}
                  />
                  <span className={online ? "dot ok" : "dot bad"} aria-label={online ? "Online" : "Offline"} />
                  <strong>{source.name}</strong>
                  {!online && <span className="bad">offline</span>}
                </div>
                {(source.config?.components.length ?? 0) === 0 ? (
                  <p className="muted">No components discovered.</p>
                ) : (
                  components(source)
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        sources[0] && components(sources[0])
      )}
    </>
  );
}

function VisibilityButton({ name, hidden, onClick }: { name: string; hidden: boolean; onClick: () => void }) {
  return (
    <button
      className="visibility"
      title={hidden ? `Show ${name}` : `Hide ${name}`}
      aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
      aria-pressed={hidden}
      onClick={onClick}
    >
      <EyeIcon open={!hidden} />
    </button>
  );
}

/** Eye (shown) or struck-through eye (hidden). */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

function Inspector(props: {
  /** The live gateway or the recording being played back. */
  feed: SceneFeed;
  sources: readonly SourceInfo[];
  selection: Selection;
  modelRef: React.RefObject<MachineScene | undefined>;
  faults: SourcedFaults[];
}) {
  const { feed, sources, selection, modelRef, faults } = props;
  useTick(200);
  // Not needed while a product is selected.
  const figures = selection?.kind === "product" ? undefined : machineMetrics(feed, sources);
  if (!selection) {
    return (
      <>
        <h2>Inspector</h2>
        <p className="muted">Select a component or product in the tree or the 3D view.</p>
        {figures && <MetricsOverview figures={figures} sources={sources} />}
      </>
    );
  }
  if (selection.kind === "product") {
    // A picked product appears twice (at the TCP and as placeholder); show the carried one.
    const matches =
      sourceScene(modelRef, selection.sourceId)?.products.filter(
        (p) => p.conveyorId === selection.conveyorId && p.productId === selection.productId,
      ) ?? [];
    const product = matches.find((p) => p.display !== "placeholder") ?? matches[0];
    const conveyor = sources
      .find((s) => s.sourceId === selection.sourceId)
      ?.config?.components.find((c) => c.id === selection.conveyorId);
    const history = feed.productHistory(selection.sourceId, selection.conveyorId, selection.productId);
    return (
      <>
        <h2>Product #{selection.productId}</h2>
        {product ? (
          <p>
            Display: <strong>{product.display}</strong> · {conveyor?.name ?? `Conveyor #${selection.conveyorId}`}
          </p>
        ) : (
          <p className="muted">Product is no longer in the register.</p>
        )}
        {history.steps.length > 0 && (
          <>
            <h3>History</h3>
            <ol className="product-history">
              {[...history.steps].reverse().map((s, i) => (
                <li key={i} className={s.kind}>
                  <span className="muted">{formatAgo(history.now - s.at)}</span> {s.text}
                </li>
              ))}
            </ol>
          </>
        )}
        {product && (
          <>
            <h3>Register entry</h3>
            <Json value={product.raw} />
          </>
        )}
      </>
    );
  }
  const source = sources.find((s) => s.sourceId === selection.sourceId);
  const component: ComponentConfig | undefined = source?.config?.components.find((c) => c.id === selection.id);
  const state: ComponentState | undefined = feed
    .latestState(selection.sourceId)
    ?.components.find((c) => c.id === selection.id);
  const delta = sourceScene(modelRef, selection.sourceId)?.deltas.find((d) => d.id === selection.id);
  return (
    <>
      <h2>{component?.name ?? `#${selection.id}`}</h2>
      {sources.length > 1 && source && <p className="muted">PLC: {source.name}</p>}
      {faults
        .find((f) => f.sourceId === selection.sourceId && f.componentId === selection.id)
        ?.messages.map((m, i) => (
          <p key={i} className="fault">
            ⚠ {m}
          </p>
        ))}
      <LimitViolations
        limits={faults.find((f) => f.sourceId === selection.sourceId && f.componentId === selection.id)?.limitViolations ?? []}
      />
      {delta && !delta.reachable && <p className="warn">Kinematics: the arms cannot reach the reported TCP.</p>}
      {figures && <ComponentMetrics figures={figures} sourceId={selection.sourceId} id={selection.id} />}
      {delta && delta.angles.length > 0 && (
        <p>
          Arm angles computed from TCP: {delta.angles.map((a) => a.toFixed(2)).join(" / ")}°
        </p>
      )}
      {state && <StateValues state={state} />}
      <h3>Config</h3>
      <Json value={component} />
      <h3>State</h3>
      <Json value={state} />
    </>
  );
}

/** The active limit violations a robot takes part in: found from the TCP limit areas, not reported by the PLC. */
function LimitViolations({ limits }: { limits: readonly string[] }) {
  if (limits.length === 0) return null;
  return (
    <>
      <h3>Limit violations</h3>
      <ul className="limit-violations">
        {limits.map((m, i) => (
          <li key={i} className="limit-violation">
            ⚠ {m}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The component's live values and lists (movers, fingers), whatever its type. */
function StateValues({ state }: { state: ComponentState }) {
  const { values, tables } = stateRows(state);
  return (
    <>
      {values.length > 0 && (
        <MoverTable head={values.map((v) => v.label)} rows={[values.map((v) => v.value)]} />
      )}
      {tables.map((t) => (
        <Fragment key={t.title}>
          <h3>{t.title}</h3>
          <MoverTable head={t.head} rows={t.rows} />
        </Fragment>
      ))}
    </>
  );
}

function MoverTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="movers">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={String(r[0])}>
            {r.map((v, i) => (
              <td key={i}>{v}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Json({ value }: { value: unknown }) {
  return <pre className="json">{value === undefined ? "–" : JSON.stringify(value, null, 2)}</pre>;
}

/** Milliseconds since the newest data of the stalest connected source; undefined before any data. */
function dataAge(store: GatewayConnection, gateway: ConnectionSnapshot): number | undefined {
  const ages = gateway.sources
    .filter(isOnline)
    .map((s) => store.dataAge(s.sourceId))
    .filter((a): a is number => a !== undefined);
  return ages.length ? Math.max(...ages) : undefined;
}

function StatusBar(props: {
  store: GatewayConnection;
  gateway: ConnectionSnapshot;
  modelRef: React.RefObject<MachineScene | undefined>;
}) {
  const { store, gateway, modelRef } = props;
  useTick(250);
  const [showErrors, setShowErrors] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const age = dataAge(store, gateway);
  const stale = age === undefined || age > STALE_AFTER_MS;
  const several = gateway.sources.length > 1;
  const prefix = (source: SourceInfo) => (several ? `${source.name}: ` : "");
  const errors = [
    ...gateway.sources.flatMap(
      (source) => source.config?.errors.map((e) => `${prefix(source)}${e.path ?? ""} ${e.message}`.trim()) ?? [],
    ),
    ...(modelRef.current?.sources.flatMap((x) => {
      const source = gateway.sources.find((s) => s.sourceId === x.sourceId);
      return x.scene.warnings.map((w) => (source ? prefix(source) + w : w));
    }) ?? []),
    ...(gateway.protocolError ? [`Protocol: ${gateway.protocolError}`] : []),
  ];
  const online = gateway.sources.length - offlineSources(gateway).length;
  const single = several ? undefined : gateway.sources[0];
  return (
    <footer className="statusbar">
      <span className={gateway.socket === "open" ? "ok" : "bad"}>Gateway: {gateway.socket}</span>
      {several ? (
        <button
          className={online === gateway.sources.length ? "ok link" : "bad link"}
          onClick={() => setShowSources((v) => !v)}
        >
          PLC: {online}/{gateway.sources.length} online
        </button>
      ) : (
        <span className={single?.status?.plcConnected ? "ok" : "bad"}>
          PLC: {single?.status ? (single.status.plcConnected ? "connected" : "not connected") : "unknown"}
          {single?.status?.lastError && !single.status.plcConnected ? ` (${single.status.lastError})` : ""}
        </span>
      )}
      <span className={stale ? "bad" : "ok"}>
        Data age: {age === undefined ? "–" : `${Math.round(age)} ms`}
        {stale ? " – stale" : ""}
      </span>
      {single?.config && <span className="muted">Config v{single.config.configVersion}</span>}
      {single?.config?.libraryVersion && <span className="muted">Syn_Visu {single.config.libraryVersion}</span>}
      <button className={errors.length ? "bad link" : "muted link"} onClick={() => setShowErrors((v) => !v)}>
        {errors.length} discovery error{errors.length === 1 ? "" : "s"}
      </button>
      <a className="muted link statusbar-api" href="/docs" target="_blank" rel="noopener" title="Guide to the PLC library Syn_Visu">
        PLC guide
      </a>
      <span className="muted statusbar-version" title="Version of this visualisation">
        v{APP_VERSION}
      </span>
      {showSources && several && (
        <ul className="errors sources-list">
          {gateway.sources.map((source) => {
            const connected = isOnline(source);
            // A connected PLC can still be unusable, e.g. with another protocol version: show its first error.
            const problem = connected ? source.config?.errors[0]?.message : source.status?.lastError;
            return (
              <li key={source.sourceId}>
                <span className={connected ? "ok" : "bad"}>{connected ? "online" : "offline"}</span>{" "}
                <strong>{source.name}</strong> <span className="muted">{source.sourceId.replace(/^ads:/, "")}</span>
                {source.config && <span className="muted"> · config v{source.config.configVersion}</span>}
                {source.config?.libraryVersion && (
                  <span className="muted"> · Syn_Visu {source.config.libraryVersion}</span>
                )}
                {problem && <span className="bad"> · {problem}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {showErrors && errors.length > 0 && (
        <ul className="errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </footer>
  );
}
