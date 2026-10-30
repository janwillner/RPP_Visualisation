import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentConfig, ComponentState } from "@rpp/protocol";
import { GatewayStore, STALE_AFTER_MS, defaultGatewayUrl, useGateway, type GatewaySnapshot } from "./connection";
import { formatPointCopy, measureChain, pointsCsv, type SceneModel, type SnapPoint, type Vec3 } from "./scene/scene-model";
import {
  MISSED_COLOR,
  PRODUCT_COLORS,
  SceneView,
  type CameraPreset,
  type Layers,
  type MeasurePoint,
  type Selection,
} from "./scene/SceneView";

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
  });
  const [selection, setSelection] = useState<Selection>();
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const toggleHidden = (id: number) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const [cameraRequest, setCameraRequest] = useState<{ preset: CameraPreset; seq: number }>({ preset: "iso", seq: 0 });
  const modelRef = useRef<SceneModel | undefined>(undefined);
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

  const camera = (preset: CameraPreset) => setCameraRequest((r) => ({ preset, seq: r.seq + 1 }));
  const toggle = (key: keyof Layers) => setLayers((l) => ({ ...l, [key]: !l[key] }));

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="title">RPP Visualisation</strong>
        <div className="group">
          <span className="muted">Camera</span>
          {(["top", "front", "iso"] as const).map((p) => (
            <button key={p} onClick={() => camera(p)}>
              {p}
            </button>
          ))}
        </div>
        <div className="group">
          <span className="muted">Layers</span>
          <Toggle label="Working areas" on={layers.workingAreas} onClick={() => toggle("workingAreas")} />
          <Toggle label="Limit areas" on={layers.limitAreas} onClick={() => toggle("limitAreas")} />
          <Toggle label="Zones" on={layers.zones} onClick={() => toggle("zones")} />
          <Toggle label="TCP markers" on={layers.tcpMarkers} onClick={() => toggle("tcpMarkers")} />
        </div>
        <div className="group">
          <Toggle label="Measure (M)" on={measureMode} onClick={() => setMeasureMode((m) => !m)} />
        </div>
      </header>
      <aside className="panel left">
        <ComponentTree
          components={gateway.config?.components ?? []}
          selection={selection}
          onSelect={setSelection}
          hidden={hidden}
          onToggleHidden={toggleHidden}
        />
      </aside>
      <main className="viewport">
        <SceneView
          store={store}
          config={gateway.config}
          layers={layers}
          selection={selection}
          onSelect={setSelection}
          cameraRequest={cameraRequest}
          modelRef={modelRef}
          measureMode={measureMode}
          onMeasure={addMeasurePoint}
          measurePoints={measurePoints}
          hidden={hidden}
        />
        {(measureMode || measurePoints.length > 0) && (
          <MeasureList measureMode={measureMode} points={measurePoints} onClear={clearMeasurePoints} />
        )}
        {!measureMode && selection?.kind === "product" && (
          <ProductLegend selection={selection} modelRef={modelRef} onClose={() => setSelection(undefined)} />
        )}
      </main>
      <aside className="panel right">
        <Inspector store={store} config={gateway.config?.components ?? []} selection={selection} modelRef={modelRef} />
      </aside>
      <StatusBar store={store} gateway={gateway} modelRef={modelRef} />
    </div>
  );
}

const fmt = (p: Vec3) => p.map((v) => v.toFixed(1)).join(" / ");

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/**
 * Measuring points as a chain: MCS coordinates, the same point in its component's frame, and offset and
 * distance to the previous point. A click on a row copies "X;Y;Z".
 */
function MeasureList(props: { measureMode: boolean; points: MeasurePoint[]; onClear: () => void }) {
  const { measureMode, points, onClear } = props;
  const chain = measureChain(points.map((p) => p.mcs));
  return (
    <div className="measure">
      {measureMode && (
        <div className="muted measure-hint">
          Measure mode · click a snap point to add it · M or Esc to leave
        </div>
      )}
      {points.length > 0 && (
        <>
          <ol className="measure-points">
            {points.map((p, i) => {
              const link = chain[i]!;
              return (
                <li key={p.id}>
                  <button className="measure-row" onClick={() => copy(formatPointCopy(p.mcs))} title="Copy X;Y;Z">
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
                        Δ {fmt(link.delta)} · distance <strong>{link.distance!.toFixed(1)}</strong> mm
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="measure-actions">
            <button className="link" onClick={() => copy(pointsCsv(points))}>
              Copy all as CSV
            </button>
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
function ProductLegend(props: {
  selection: { kind: "product"; conveyorId: number; productId: number };
  modelRef: React.RefObject<SceneModel | undefined>;
  onClose: () => void;
}) {
  const { selection, modelRef, onClose } = props;
  useTick(200);
  const matches =
    modelRef.current?.products.filter(
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

function ComponentTree(props: {
  components: ComponentConfig[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  hidden: ReadonlySet<number>;
  onToggleHidden: (id: number) => void;
}) {
  const { components, selection, onSelect, hidden, onToggleHidden } = props;
  return (
    <>
      <h2>Components</h2>
      {components.length === 0 && <p className="muted">No components discovered.</p>}
      <ul className="tree">
        {components.map((c) => (
          <li key={c.id} className={hidden.has(c.id) ? "hidden" : ""}>
            <button
              className="visibility"
              title={hidden.has(c.id) ? `Show ${c.name}` : `Hide ${c.name}`}
              aria-label={hidden.has(c.id) ? `Show ${c.name}` : `Hide ${c.name}`}
              aria-pressed={hidden.has(c.id)}
              onClick={() => onToggleHidden(c.id)}
            >
              <EyeIcon open={!hidden.has(c.id)} />
            </button>
            <button
              className={selection?.kind === "component" && selection.id === c.id ? "selected" : ""}
              onClick={() => onSelect({ kind: "component", id: c.id })}
            >
              <span className={`badge ${c.type}`}>{c.type}</span> {c.name} <span className="muted">#{c.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
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
  config: ComponentConfig[];
  selection: Selection;
  modelRef: React.RefObject<SceneModel | undefined>;
}) {
  const { store, config, selection, modelRef } = props;
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
      modelRef.current?.products.filter(
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
  const component = config.find((c) => c.id === selection.id);
  const state: ComponentState | undefined = store.latest()?.components.find((c) => c.id === selection.id);
  const delta = modelRef.current?.deltas.find((d) => d.id === selection.id);
  return (
    <>
      <h2>{component?.name ?? `#${selection.id}`}</h2>
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
            head={["Id", "Position", "X", "Gripper"]}
            rows={state.movers.map((m) => [m.id, m.position.toFixed(1), m.x.toFixed(1), m.gripperActive ? "on" : "off"])}
          />
        </>
      )}
      {state?.type === "xtsLoop" && (
        <>
          <h3>Movers</h3>
          <MoverTable head={["Id", "s"]} rows={state.movers.map((m) => [m.id, m.position.toFixed(1)])} />
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

function StatusBar(props: {
  store: GatewayStore;
  gateway: GatewaySnapshot;
  modelRef: React.RefObject<SceneModel | undefined>;
}) {
  const { store, gateway, modelRef } = props;
  useTick(250);
  const [showErrors, setShowErrors] = useState(false);
  const age = store.dataAge();
  const stale = age === undefined || age > STALE_AFTER_MS;
  const errors = [
    ...(gateway.config?.errors.map((e) => `${e.path ?? ""} ${e.message}`.trim()) ?? []),
    ...(modelRef.current?.warnings ?? []),
    ...(gateway.protocolError ? [`Protocol: ${gateway.protocolError}`] : []),
  ];
  return (
    <footer className="statusbar">
      <span className={gateway.socket === "open" ? "ok" : "bad"}>Gateway: {gateway.socket}</span>
      <span className={gateway.status?.plcConnected ? "ok" : "bad"}>
        PLC: {gateway.status ? (gateway.status.plcConnected ? "connected" : "not connected") : "unknown"}
        {gateway.status?.lastError && !gateway.status.plcConnected ? ` (${gateway.status.lastError})` : ""}
      </span>
      <span className={stale ? "bad" : "ok"}>
        Data age: {age === undefined ? "–" : `${Math.round(age)} ms`}
        {stale ? " – stale" : ""}
      </span>
      {gateway.config && <span className="muted">Config v{gateway.config.configVersion}</span>}
      <button className={errors.length ? "bad link" : "muted link"} onClick={() => setShowErrors((s) => !s)}>
        {errors.length} discovery error{errors.length === 1 ? "" : "s"}
      </button>
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
