import type { Selection } from "../scene/SceneView";
import type { SourcedFaults } from "../scene/scene-model";
import { activeMachineMessages, machineMessagePlace, machineMessageText, runStateText } from "../machine-facts";
import { componentKey } from "../scene/scene-model";
import { isOnline, type SourceInfo } from "../sources";

/**
 * The components of every source. With more than one source they are grouped under the source's name, with its
 * online state and an eye for the whole source.
 */
export function ComponentTree(props: {
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
    <>
    <MachineSummary source={source} onSelect={onSelect} />
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
    </>
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

/** PLC distributed clock time (ns since 2000-01-01) as a local time of day. */
function dcTimeOfDay(time: string): string {
  const ms = Date.UTC(2000, 0, 1) + Number(BigInt(time) / 1_000_000n);
  return new Date(ms).toLocaleTimeString();
}

/**
 * The machine as its application reports it (ADR 0021): run state, simulation mode and the active machine messages,
 * above the components; a click on a message about a component selects it. Nothing for an application without the
 * machine entry.
 */
function MachineSummary({ source, onSelect }: { source: SourceInfo; onSelect: (s: Selection) => void }) {
  const machine = source.machine;
  if (!machine) return null;
  const messages = activeMachineMessages(machine);
  // Offline, it is only what the application reported last.
  const stale = !isOnline(source);
  return (
    <div className={stale ? "machine stale" : "machine"}>
      <div className={`run-state ${machine.runState}`}>
        {runStateText(machine)}
        {machine.simulation && <span className="muted"> · simulation</span>}
        {stale && <span className="muted"> · last reported</span>}
      </div>
      {messages.length > 0 && (
        <ul className="machine-messages" aria-label="Machine messages">
          {messages.map((m) => {
            const content = (
              <>
                <strong>{machineMessagePlace(m, source.config, source.name)}</strong>: {machineMessageText(m)}{" "}
                <span className="muted">{dcTimeOfDay(m.time)}</span>
              </>
            );
            return (
              <li key={m.id} className={m.severity}>
                {m.componentId === 0 ? (
                  content
                ) : (
                  <button className="link" onClick={() => onSelect({ kind: "component", sourceId: source.sourceId, id: m.componentId })}>
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
