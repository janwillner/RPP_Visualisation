import { useEffect, useMemo, useRef, useState } from "react";
import type { Fault, ComponentConfig, ComponentState } from "@rpp/protocol";
import {
  GatewayStore,
  STALE_AFTER_MS,
  defaultGatewayUrl,
  isOnline,
  useGateway,
  type GatewaySnapshot,
  type SourceInfo,
} from "./connection";
import {
  componentKey,
  faultText,
  formatPointCopy,
  measureChain,
  pointsCsv,
  type MachineScene,
  type SceneModel,
  type SnapPoint,
  type SourcedFaults,
  type Vec3,
} from "./scene/scene-model";
import {
  MISSED_COLOR,
  PRODUCT_COLORS,
  SceneView,
  type CameraAction,
  type Layers,
  type MeasurePoint,
  type Selection,
} from "./scene/SceneView";

/** `?embedded`: the page is a frame inside the machine HMI, which has its own header; title and status bar go. */
const EMBEDDED = new URLSearchParams(window.location.search).has("embedded");
/** The clipboard exists only in a secure context (https or localhost), not when embedded over http. */
const CAN_COPY = window.isSecureContext && navigator.clipboard !== undefined;
/** From this window width the side panels start open; below, the 3D view gets the room. */
const WIDE_SCREEN_PX = 1600;

/** Whether a side panel is open: remembered per device, else open on wide screens only. */
function usePanelOpen(storageKey: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return stored === "1";
    } catch {
      // Storage may be blocked (private window, embedded frame): fall back to the width.
    }
    return window.innerWidth >= WIDE_SCREEN_PX;
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
  const store = useMemo(() => new GatewayStore(defaultGatewayUrl()), []);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const gateway = useGateway(store);
  const [layers, setLayers] = useState<Layers>({
    workingAreas: true,
    limitAreas: true,
    zones: true,
    tcpMarkers: true,
    faultLabels: true,
  });
  const [faults, setFaults] = useState<SourcedFaults[]>([]);
  const [selection, setSelection] = useState<Selection>();
  // Component keys, and source ids for whole sources.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const toggleHidden = (key: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const [cameraRequest, setCameraRequest] = useState<{ action: CameraAction; seq: number }>({ action: "iso", seq: 0 });
  const [leftOpen, toggleLeft] = usePanelOpen("rpp.panel.components");
  const [rightOpen, toggleRight] = usePanelOpen("rpp.panel.inspector");
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

  const camera = (action: CameraAction) => setCameraRequest((r) => ({ action, seq: r.seq + 1 }));
  const toggle = (key: keyof Layers) => setLayers((l) => ({ ...l, [key]: !l[key] }));
  const appClass = ["app", EMBEDDED && "embedded", !leftOpen && "left-closed", !rightOpen && "right-closed"]
    .filter(Boolean)
    .join(" ");

  return (
    // A long press on a touch screen opens no context menu: the app has no secondary actions.
    <div
      className={appClass}
      onContextMenu={(e) => {
        if ((e.nativeEvent as PointerEvent).pointerType === "touch") e.preventDefault();
      }}
    >
      <header className="toolbar">
        {!EMBEDDED && <strong className="title">RPP Visualisation</strong>}
        <div className="group">
          <Toggle label="Components" on={leftOpen} onClick={toggleLeft} />
          <Toggle label="Inspector" on={rightOpen} onClick={toggleRight} />
        </div>
        <div className="group">
          <span className="muted">Layers</span>
          <Toggle label="Working areas" on={layers.workingAreas} onClick={() => toggle("workingAreas")} />
          <Toggle label="Limit areas" on={layers.limitAreas} onClick={() => toggle("limitAreas")} />
          <Toggle label="Zones" on={layers.zones} onClick={() => toggle("zones")} />
          <Toggle label="TCP markers" on={layers.tcpMarkers} onClick={() => toggle("tcpMarkers")} />
          <Toggle label="Fault labels" on={layers.faultLabels} onClick={() => toggle("faultLabels")} />
        </div>
        <div className="group">
          <Toggle label="Measure (M)" on={measureMode} onClick={() => setMeasureMode((m) => !m)} />
        </div>
      </header>
      <aside className="panel left" hidden={!leftOpen}>
        <ComponentTree
          gateway={gateway}
          selection={selection}
          onSelect={setSelection}
          hidden={hidden}
          onToggleHidden={toggleHidden}
          faults={faults}
        />
      </aside>
      {/* No context menu on a long press: there are no secondary actions in the 3D view. */}
      <main className="viewport" onContextMenu={(e) => e.preventDefault()}>
        <SceneView
          store={store}
          sources={gateway.sources}
          layers={layers}
          selection={selection}
          onSelect={setSelection}
          cameraRequest={cameraRequest}
          modelRef={modelRef}
          measureMode={measureMode}
          onMeasure={addMeasurePoint}
          measurePoints={measurePoints}
          hidden={hidden}
          onFaults={setFaults}
        />
        <ViewControls onCamera={camera} />
        {EMBEDDED && <OfflineNotice gateway={gateway} />}
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
          store={store}
          sources={gateway.sources}
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
function offlineSources(gateway: GatewaySnapshot): SourceInfo[] {
  return gateway.sources.filter((s) => !isOnline(gateway, s));
}

/** Embedded there is no status bar: a red note in the 3D view tells that (part of) the machine is not live. */
function OfflineNotice({ gateway }: { gateway: GatewaySnapshot }) {
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

const VIEWS: { action: CameraAction; label: string; title: string }[] = [
  { action: "top", label: "Top", title: "View from above" },
  { action: "front", label: "Front", title: "View from the front (along +Y)" },
  { action: "side", label: "Side", title: "View from the side (along +X)" },
  { action: "iso", label: "Iso", title: "Isometric view of the whole machine" },
];

/** Camera buttons in the 3D view, so every view is reachable with one finger (no pinch needed). */
function ViewControls({ onCamera }: { onCamera: (action: CameraAction) => void }) {
  return (
    <div className="view-controls" role="toolbar" aria-label="Camera">
      {VIEWS.map((v) => (
        <button key={v.action} title={v.title} onClick={() => onCamera(v.action)}>
          {v.label}
        </button>
      ))}
      <button title="Zoom in" aria-label="Zoom in" onClick={() => onCamera("zoomIn")}>
        +
      </button>
      <button title="Zoom out" aria-label="Zoom out" onClick={() => onCamera("zoomOut")}>
        −
      </button>
      {/* The start view: the whole machine, isometric. */}
      <button title="Back to the start view" onClick={() => onCamera("iso")}>
        Reset
      </button>
    </div>
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
    ...Object.entries(PRODUCT_COLORS).map(([state, color]) => ({ key: state, color, active: state === current })),
    { key: "missed", color: MISSED_COLOR, active: current === "missed" },
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
  gateway: GatewaySnapshot;
  selection: Selection;
  onSelect: (s: Selection) => void;
  hidden: ReadonlySet<string>;
  onToggleHidden: (key: string) => void;
  faults: SourcedFaults[];
}) {
  const { gateway, selection, onSelect, hidden, onToggleHidden, faults } = props;
  const grouped = gateway.sources.length > 1;
  // A source that never answered has no config and appears only in the status bar.
  const sources = gateway.sources.filter((s) => s.config !== undefined);
  const components = (source: SourceInfo) => (
    <ul className="tree">
      {(source.config?.components ?? []).map((c) => {
        const key = componentKey(source.sourceId, c.id);
        const isHidden = hidden.has(key) || hidden.has(source.sourceId);
        const messages = faults.find((f) => f.sourceId === source.sourceId && f.componentId === c.id)?.messages;
        return (
          <li key={key} className={[isHidden ? "hidden" : "", messages ? "faulted" : ""].join(" ").trim()}>
            <VisibilityButton name={c.name} hidden={hidden.has(key)} onClick={() => onToggleHidden(key)} />
            <button
              className={
                selection?.kind === "component" && selection.sourceId === source.sourceId && selection.id === c.id
                  ? "selected"
                  : ""
              }
              onClick={() => onSelect({ kind: "component", sourceId: source.sourceId, id: c.id })}
            >
              {messages && (
                <span className="fault-icon" aria-label="Fault">
                  ⚠
                </span>
              )}
              <span className={`badge ${c.type}`}>{c.type}</span> {c.name} <span className="muted">#{c.id}</span>
            </button>
            {/* Visible, not a tooltip: a touch panel shows no tooltips. */}
            {messages && (
              <ul className="fault-lines">
                {messages.map((m, i) => (
                  <li key={i}>{m}</li>
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
            const online = isOnline(gateway, source);
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
  store: GatewayStore;
  sources: SourceInfo[];
  selection: Selection;
  modelRef: React.RefObject<MachineScene | undefined>;
  faults: SourcedFaults[];
}) {
  const { store, sources, selection, modelRef, faults } = props;
  useTick(200);
  if (!selection) {
    return (
      <>
        <h2>Inspector</h2>
        <p className="muted">Select a component or product in the tree or the 3D view.</p>
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
    return (
      <>
        <h2>Product</h2>
        {product ? (
          <>
            <p>
              Display: <strong>{product.display}</strong> · Conveyor #{product.conveyorId}
            </p>
            <h3>Register entry</h3>
            <Json value={product.raw} />
          </>
        ) : (
          <p className="muted">Product is no longer in the register.</p>
        )}
      </>
    );
  }
  const source = sources.find((s) => s.sourceId === selection.sourceId);
  const component: ComponentConfig | undefined = source?.config?.components.find((c) => c.id === selection.id);
  const state: ComponentState | undefined = store
    .buffer(selection.sourceId)
    .latest()
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
      {delta && !delta.reachable && <p className="warn">Kinematics: the arms cannot reach the reported TCP.</p>}
      {delta && delta.angles.length > 0 && (
        <p>
          Arm angles computed from TCP: {delta.angles.map((a) => a.toFixed(2)).join(" / ")}°
        </p>
      )}
      {state?.type === "xtsGantry" && (
        <>
          <h3>Movers · Z {state.z.toFixed(1)}</h3>
          <MoverTable
            head={["Id", "Position", "X", "Gripper", "Fault"]}
            rows={state.movers.map((m) => [
              m.id,
              m.position.toFixed(1),
              m.x.toFixed(1),
              m.gripperActive ? "on" : "off",
              faultCell(m.fault),
            ])}
          />
        </>
      )}
      {state?.type === "xtsLoop" && (
        <>
          <h3>Movers</h3>
          <MoverTable
            head={["Id", "s", "Fault"]}
            rows={state.movers.map((m) => [m.id, m.position.toFixed(1), faultCell(m.fault)])}
          />
        </>
      )}
      {state?.type === "cartesian" && (
        <>
          <h3>Axes</h3>
          <MoverTable
            head={["X", "Y", "Z", "Gripper"]}
            rows={[[...[state.x, state.y, state.z].map((v) => v.toFixed(1)), state.gripperActive ? "on" : "off"]]}
          />
        </>
      )}
      {state && "fingers" in (component ?? {}) && <FingerTable state={state} />}
      <h3>Config</h3>
      <Json value={component} />
      <h3>State</h3>
      <Json value={state} />
    </>
  );
}

/** Live finger poses (MCS) and grip state, per mover for XTS kinematics. */
function FingerTable({ state }: { state: ComponentState }) {
  const groups =
    state.type === "xtsGantry" || state.type === "xtsLoop"
      ? state.movers.map((m) => ({ moverId: m.id, fingers: m.fingers }))
      : state.type === "delta" || state.type === "cartesian"
        ? [{ moverId: 0, fingers: state.fingers }]
        : [];
  const rows = groups.flatMap((g) =>
    g.fingers.map((f, i) => [
      g.moverId ? `${g.moverId}.${i + 1}` : String(i + 1),
      ...[f.pose.x, f.pose.y, f.pose.z, f.pose.rx, f.pose.ry, f.pose.rz].map((v) => v.toFixed(1)),
      f.active ? "on" : "off",
    ]),
  );
  if (rows.length === 0) return null;
  return (
    <>
      <h3>Fingers</h3>
      <MoverTable head={["Finger", "X", "Y", "Z", "Rx", "Ry", "Rz", "Grip"]} rows={rows} />
    </>
  );
}

/** A mover's fault as table text; empty when there is none. */
const faultCell = (fault: Fault | null) => faultText(fault) ?? "";

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
function dataAge(store: GatewayStore, gateway: GatewaySnapshot): number | undefined {
  const ages = gateway.sources
    .filter((s) => s.status?.plcConnected)
    .map((s) => store.buffer(s.sourceId).dataAge())
    .filter((a): a is number => a !== undefined);
  return ages.length ? Math.max(...ages) : undefined;
}

function StatusBar(props: {
  store: GatewayStore;
  gateway: GatewaySnapshot;
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
      <button className={errors.length ? "bad link" : "muted link"} onClick={() => setShowErrors((v) => !v)}>
        {errors.length} discovery error{errors.length === 1 ? "" : "s"}
      </button>
      {showSources && several && (
        <ul className="errors sources-list">
          {gateway.sources.map((source) => {
            const connected = isOnline(gateway, source);
            // A connected PLC can still be unusable, e.g. with another protocol version: show its first error.
            const problem = connected ? source.config?.errors[0]?.message : source.status?.lastError;
            return (
              <li key={source.sourceId}>
                <span className={connected ? "ok" : "bad"}>{connected ? "online" : "offline"}</span>{" "}
                <strong>{source.name}</strong> <span className="muted">{source.sourceId.replace(/^ads:/, "")}</span>
                {source.config && <span className="muted"> · config v{source.config.configVersion}</span>}
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
