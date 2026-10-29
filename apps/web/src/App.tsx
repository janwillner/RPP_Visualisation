import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentConfig, ComponentState } from "@rpp/protocol";
import { GatewayStore, STALE_AFTER_MS, defaultGatewayUrl, useGateway, type GatewaySnapshot } from "./connection";
import type { SceneModel } from "./scene/scene-model";
import {
  MISSED_COLOR,
  PRODUCT_COLORS,
  SceneView,
  formatMcs,
  type CameraPreset,
  type Layers,
  type McsHit,
  type McsPin,
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
  const [layers, setLayers] = useState<Layers>({ workAreas: true, windows: true, tcpMarkers: true });
  const [selection, setSelection] = useState<Selection>();
  const [cameraRequest, setCameraRequest] = useState<{ preset: CameraPreset; seq: number }>({ preset: "iso", seq: 0 });
  const modelRef = useRef<SceneModel | undefined>(undefined);
  // Written on every pointer move; read by the readout at a fixed rate, so moving the mouse never re-renders the app.
  const hoverRef = useRef<McsHit | undefined>(undefined);
  const [pins, setPins] = useState<McsPin[]>([]);
  const nextPinId = useRef(1);
  const addPin = (hit: McsHit) => setPins((p) => [...p, { ...hit, id: nextPinId.current++ }]);

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
          <Toggle label="Work areas" on={layers.workAreas} onClick={() => toggle("workAreas")} />
          <Toggle label="Windows" on={layers.windows} onClick={() => toggle("windows")} />
          <Toggle label="TCP markers" on={layers.tcpMarkers} onClick={() => toggle("tcpMarkers")} />
        </div>
        <Legend />
      </header>
      <aside className="panel left">
        <ComponentTree components={gateway.config?.components ?? []} selection={selection} onSelect={setSelection} />
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
          onPointerMcs={(hit) => (hoverRef.current = hit)}
          onPin={addPin}
          pins={pins}
        />
        <CoordinateReadout
          hoverRef={hoverRef}
          pins={pins}
          onRemove={(id) => setPins((p) => p.filter((x) => x.id !== id))}
          onClear={() => setPins([])}
        />
      </main>
      <aside className="panel right">
        <Inspector store={store} config={gateway.config?.components ?? []} selection={selection} modelRef={modelRef} />
      </aside>
      <StatusBar store={store} gateway={gateway} modelRef={modelRef} />
    </div>
  );
}

/** Live MCS coordinates under the pointer, plus the measuring points placed with Shift+click. */
function CoordinateReadout(props: {
  hoverRef: React.RefObject<McsHit | undefined>;
  pins: McsPin[];
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  const { hoverRef, pins, onRemove, onClear } = props;
  useTick(100);
  const hover = hoverRef.current;
  return (
    <div className="coords">
      <div className="coords-live">
        <span className="muted">MCS</span>{" "}
        {hover ? (
          <>
            <strong>{formatMcs(hover.point)}</strong> mm <span className="muted">{hover.label}</span>
          </>
        ) : (
          <span className="muted">point at the scene · Shift+click places a measuring point</span>
        )}
      </div>
      {pins.length > 0 && (
        <>
          <table className="coords-pins">
            <thead>
              <tr>
                <th>#</th>
                <th>X</th>
                <th>Y</th>
                <th>Z</th>
                <th>On</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pins.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  {p.point.map((v, i) => (
                    <td key={i} className="num">
                      {v.toFixed(1)}
                    </td>
                  ))}
                  <td className="muted">{p.label}</td>
                  <td>
                    <button className="link" onClick={() => onRemove(p.id)} aria-label={`Remove point ${p.id}`}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="link muted" onClick={onClear}>
            Clear points
          </button>
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

function Legend() {
  return (
    <div className="group legend">
      {Object.entries(PRODUCT_COLORS).map(([state, color]) => (
        <span key={state}>
          <i style={{ background: color }} /> {state}
        </span>
      ))}
      <span>
        <i style={{ background: MISSED_COLOR }} /> missed
      </span>
      <span>
        <i className="outline" /> placeholder
      </span>
    </div>
  );
}

function ComponentTree(props: {
  components: ComponentConfig[];
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const { components, selection, onSelect } = props;
  return (
    <>
      <h2>Components</h2>
      {components.length === 0 && <p className="muted">No components discovered.</p>}
      <ul className="tree">
        {components.map((c) => (
          <li key={c.id}>
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
      <h3>Config</h3>
      <Json value={component} />
      <h3>State</h3>
      <Json value={state} />
    </>
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
