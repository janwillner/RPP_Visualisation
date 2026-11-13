import { Fragment } from "react";
import type { ComponentConfig, ComponentState, StateMessage } from "@rpp/protocol";
import { markName } from "../machine-facts";
import { CLIENT_ACTIONS, METRICS_WINDOW_MS, metrics, type ClientMetrics, type MachineMetrics } from "../metrics";
import { MARK } from "../palette";
import type { ProductEvent, ProductStep } from "../product-history";
import type { MachineScene, SceneModel, SourcedFaults } from "../scene/scene-model";
import type { Selection } from "../scene/SceneView";
import type { SourceInfo } from "../sources";
import { stateRows } from "../state-rows";
import { useTick } from "../use-tick";

/** What the inspector reads of what is shown: the live machine or a recording in playback. */
export interface InspectorFeed {
  /** A source's newest state. */
  latestState(sourceId: string): StateMessage | undefined;
  /** What has happened to a product so far, and the current moment on the same clock. */
  productHistory(sourceId: string, conveyorId: number, productId: number): { steps: readonly ProductStep[]; now: number };
  /** Product events of the last `windowMs`, the current moment and when the data starts, for the metrics. */
  productEvents(windowMs: number): { events: readonly ProductEvent[]; now: number; since: number };
}

/** The scene of one source, by manifest ids. */
export function sourceScene(modelRef: React.RefObject<MachineScene | undefined>, sourceId: string): SceneModel | undefined {
  return modelRef.current?.sources.find((s) => s.sourceId === sourceId)?.scene;
}

function machineMetrics(feed: InspectorFeed, sources: readonly SourceInfo[]): MachineMetrics {
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


export function Inspector(props: {
  /** The live gateway or the recording being played back. */
  feed: InspectorFeed;
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
    const source = sources.find((s) => s.sourceId === selection.sourceId);
    const conveyor = source?.config?.components.find((c) => c.id === selection.conveyorId);
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
        {product && product.mark > 0 && (
          <p className="product-mark">
            Mark: <i style={{ background: MARK[product.mark - 1] }} />{" "}
            <strong>{markName(source?.config?.marks, product.mark)}</strong>
          </p>
        )}
        {product && product.mark === 0 && (product.raw.mark ?? 0) !== 0 && (
          // A number the PLC should not report: drawn unmarked, named here so the fault can be found.
          <p className="product-mark">
            Mark: <strong>{product.raw.mark}</strong> <span className="muted">(no such mark, drawn unmarked)</span>
          </p>
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
