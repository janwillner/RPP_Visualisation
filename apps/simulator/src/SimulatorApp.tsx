import { useEffect, useMemo, useRef, useState } from "react";
import type { MachineCommandKind } from "@rpp/protocol";
import {
  type CameraPreset,
  ComponentTree,
  defaultGatewayUrl,
  download,
  GatewayConnection,
  GatewayLive,
  Inspector,
  LayerToggles,
  type Layers,
  LiveMachine,
  type MachineScene,
  NumberInput,
  runStateText,
  SceneView,
  SidePanelControls,
  sidePanelsLayout,
  type SourcedFaults,
  StatusBar,
  StatusList,
  TextInput,
  TopBar,
  useSidePanel,
  useStore,
  ViewControls,
} from "@rpp/machine-view";
import {
  COMMANDS,
  RECIPE_FILE_EXTENSION,
  type CommandState,
  type RecipeFormField,
  type RecipeFormGroup,
  type RecipeWrite,
  shownValue,
  Simulator,
  type SimulatorSnapshot,
  useSimulator,
} from "./simulator";

/** The machine's products and their zones matter here; areas and coordinate systems stay off until switched on. */
const LAYERS: Layers = {
  workingAreas: false,
  limitAreas: false,
  zones: true,
  tcpMarkers: true,
  faultLabels: true,
  origins: false,
  marks: true,
};

const COMMAND_LABELS: Record<MachineCommandKind, string> = { start: "Start", stop: "Stop", reset: "Reset" };

/**
 * The Simulator page (ADR 0020): the machine in 3D with its components on the left, the recipe and the metrics on
 * the right, Start / Stop / Reset at the top, problems and machine messages in the status bar. Everything it does
 * goes through the `Simulator`; the page only binds it.
 */
export function SimulatorApp() {
  const store = useMemo(() => new GatewayConnection(defaultGatewayUrl()), []);
  // The live machine with the product history the metrics count, and the recipe with the commands on it.
  const live = useMemo(() => new LiveMachine(store), [store]);
  const simulator = useMemo(
    () => new Simulator(new GatewayLive(store), () => window.confirm("Discard the recipe changes that were not saved?")),
    [store],
  );
  useEffect(() => {
    store.start();
    simulator.start();
    return () => {
      simulator.stop();
      store.stop();
    };
  }, [store, simulator]);
  const gateway = useStore(store);
  const snapshot = useSimulator(simulator);
  const modelRef = useRef<MachineScene | undefined>(undefined);
  const [layers, setLayers] = useState<Layers>(LAYERS);
  const [faults, setFaults] = useState<SourcedFaults[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [cameraRequest, setCameraRequest] = useState<{ action: CameraPreset; seq: number }>({ action: "iso", seq: 0 });
  // Both start open: the recipe is what the page is for. Open state and width are remembered on this device.
  const left = useSidePanel("rpp.simulator.panel.left", "Components", () => true);
  const right = useSidePanel("rpp.simulator.panel.right", "Recipe", () => true);
  const panels = sidePanelsLayout(left, right);

  // Leaving the page with recipe changes that were not saved asks first.
  useEffect(() => {
    if (snapshot.saved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [snapshot.saved]);

  return (
    <div className={["app simulator", panels.className].filter(Boolean).join(" ")} style={panels.style}>
      <TopBar title="RPP Simulator">
        <MachineControls simulator={simulator} snapshot={snapshot} />
        <a className="muted link" href="/" target="_blank" rel="noopener" title="Open the visualisation of the machine">
          Visualisation
        </a>
        <LayerToggles layers={layers} onToggle={(key) => setLayers((l) => ({ ...l, [key]: !l[key] }))} />
      </TopBar>

      <aside className="panel left" hidden={!left.open}>
        <ComponentTree
          sources={gateway.sources}
          selection={snapshot.selection}
          onSelect={(s) => simulator.select(s)}
          hidden={hidden}
          onToggleHidden={(key) =>
            setHidden((h) => {
              const next = new Set(h);
              if (!next.delete(key)) next.add(key);
              return next;
            })
          }
          faults={faults}
        />
      </aside>

      <main className="viewport" onContextMenu={(e) => e.preventDefault()}>
        <SceneView
          frame={(now) => live.frame(now)}
          layers={layers}
          selection={snapshot.selection}
          onSelect={(s) => simulator.select(s)}
          cameraRequest={cameraRequest}
          modelRef={modelRef}
          measureMode={false}
          onMeasure={() => {}}
          measurePoints={[]}
          hidden={hidden}
          onFaults={(f) => {
            setFaults(f);
            simulator.setFaults(f);
          }}
        />
        <SidePanelControls left={left} right={right} />
        <ViewControls onCamera={(action) => setCameraRequest((r) => ({ action, seq: r.seq + 1 }))} />
        {snapshot.notice && (
          <div className="recording-notice" role="alert">
            {snapshot.notice} <button onClick={() => simulator.dismissNotice()}>OK</button>
          </div>
        )}
      </main>

      <aside className="panel right" hidden={!right.open}>
        <RecipePanel simulator={simulator} snapshot={snapshot} />
        <Inspector feed={live} sources={gateway.sources} selection={snapshot.selection} modelRef={modelRef} faults={faults} />
      </aside>

      <StatusBar store={store} gateway={gateway} modelRef={modelRef}>
        <StatusList
          noun={["problem", "problems"]}
          items={snapshot.problems.map((p) => ({
            text: p.text,
            severity: p.severity,
            ...(p.selection ? { onSelect: () => simulator.select(p.selection) } : {}),
          }))}
        />
        <StatusList
          className="status-messages"
          noun={["message", "messages"]}
          items={snapshot.messages.map((m) => ({
            text: m.text,
            severity: m.severity,
            ...(m.selection ? { onSelect: () => simulator.select(m.selection) } : {}),
          }))}
        />
      </StatusBar>
    </div>
  );
}

/** The source choice, the run state and Start / Stop / Reset with the application's answer. */
function MachineControls({ simulator, snapshot }: { simulator: Simulator; snapshot: SimulatorSnapshot }) {
  const { machine, sources } = snapshot;
  return (
    <>
      {sources.length > 1 && (
        <select aria-label="PLC" value={snapshot.sourceId} onChange={(e) => simulator.selectSource(e.target.value)}>
          {sources.map((s) => (
            <option key={s.sourceId} value={s.sourceId}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <span className={machine ? `run-state ${machine.runState}` : "muted"} aria-label="Run state">
        {machine ? runStateText(machine) : "No machine reported"}
        {machine && !machine.simulation && <span className="bad"> · not in simulation mode</span>}
      </span>
      <div className="group">
        {COMMANDS.map((kind) => (
          <button
            key={kind}
            disabled={!snapshot.commands[kind].enabled}
            title={snapshot.commands[kind].reason ?? `${COMMAND_LABELS[kind]} the machine`}
            onClick={() => void simulator.command(kind)}
          >
            {COMMAND_LABELS[kind]}
          </button>
        ))}
      </div>
      {snapshot.command && <CommandAnswer command={snapshot.command} />}
    </>
  );
}

function CommandAnswer({ command }: { command: CommandState }) {
  const name = COMMAND_LABELS[command.command];
  switch (command.state) {
    case "sent":
      return <span className="muted">{name} sent…</span>;
    case "accepted":
      return <span className="ok">{name} accepted</span>;
    case "rejected":
      return <span className="bad">{`${name} rejected${command.message ? `: ${command.message}` : ""}`}</span>;
    case "failed":
      return <span className="bad">{`${name} failed: ${command.message}`}</span>;
  }
}

/** The recipe form by component, its file, and writing it to the PLC. */
function RecipePanel({ simulator, snapshot }: { simulator: Simulator; snapshot: SimulatorSnapshot }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { recipe, form } = snapshot;
  const plan = simulator.writePlan();
  const count = plan.changes.length;
  return (
    <section className="recipe">
      <h3>Recipe</h3>
      <label className="property">
        <span>Name</span>
        <TextInput value={snapshot.name} label="Recipe name" onCommit={(name) => simulator.rename(name)} />
      </label>
      <div className="group">
        <button onClick={() => fileInput.current?.click()}>Open…</button>
        <button
          onClick={() => {
            // A value still being typed is taken first.
            (document.activeElement as HTMLElement | null)?.blur();
            const file = simulator.save();
            download(file.text, file.name, "application/json");
          }}
        >
          Save
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={`${RECIPE_FILE_EXTENSION},.json,application/json`}
          hidden
          aria-label="Open a recipe file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) simulator.open(await file.text());
          }}
        />
        {!snapshot.saved && <span className="muted">not saved</span>}
      </div>

      {!recipe ? (
        <p className="muted">{plan.blocked ?? "The PLC declares no recipe."}</p>
      ) : (
        <>
          {form.map((group) => (
            <RecipeGroup key={group.group} group={group} simulator={simulator} />
          ))}
          <p className="muted">
            {recipe.activeVersion > 0 ? `Recipe v${recipe.activeVersion} active in the PLC.` : "The PLC runs its program values."}
          </p>
          <div className="group">
            <button
              disabled={plan.blocked !== undefined || count === 0}
              title={plan.blocked ?? (count === 0 ? "Nothing changed." : plan.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join("\n"))}
              onClick={() => void simulator.write()}
            >
              {count === 0 ? "Write" : `Write ${count} change${count === 1 ? "" : "s"}`}
            </button>
            <button disabled={count === 0} onClick={() => simulator.discardEdits()}>
              Discard
            </button>
            <button
              disabled={recipe.activeVersion === 0 || snapshot.blocked !== undefined}
              title={snapshot.blocked ?? "Return the machine to its application's program values"}
              onClick={() => {
                if (window.confirm("Return the machine to its program values?")) void simulator.resetRecipe();
              }}
            >
              Program values
            </button>
          </div>
          {plan.blocked && count > 0 && <p className="bad">{plan.blocked}</p>}
          {snapshot.write && <WriteStatus write={snapshot.write} />}
        </>
      )}
    </section>
  );
}

/** A component's recipe fields; the group of the selected component is marked and scrolled into view. */
function RecipeGroup({ group, simulator }: { group: RecipeFormGroup; simulator: Simulator }) {
  const ref = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (group.selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [group.selected]);
  return (
    <fieldset ref={ref} className={group.selected ? "selected" : undefined}>
      <legend>{group.name}</legend>
      {group.fields.map((f) => (
        <RecipeInput key={f.field.name} field={f} onCommit={(value) => simulator.edit(f.field.name, value)} />
      ))}
    </fieldset>
  );
}

function RecipeInput({ field: f, onCommit }: { field: RecipeFormField; onCommit: (value: number | boolean) => void }) {
  const { field } = f;
  const label = field.unit ? `${f.label} [${field.unit}]` : f.label;
  const range = field.type === "number" || field.type === "integer" ? `${field.min} to ${field.max}` : undefined;
  return (
    <div className={f.changed ? "recipe-field changed" : "recipe-field"}>
      <label className="property" title={range}>
        <span>{label}</span>
        {(field.type === "number" || field.type === "integer") && (
          <NumberInput
            value={typeof f.value === "number" ? f.value : Number(f.value)}
            integer={field.type === "integer"}
            label={f.label}
            onCommit={onCommit}
          />
        )}
        {field.type === "switch" && (
          <input type="checkbox" aria-label={f.label} checked={f.value === true} onChange={(e) => onCommit(e.target.checked)} />
        )}
        {field.type === "choice" && (
          <select aria-label={f.label} value={String(f.value)} onChange={(e) => onCommit(Number(e.target.value))}>
            {!field.choices[Number(f.value)] && <option value={String(f.value)}>#{String(f.value)} (unknown)</option>}
            {field.choices.map((text, i) => (
              <option key={i} value={i}>
                {text}
              </option>
            ))}
          </select>
        )}
      </label>
      {f.changed && <div className="hint muted">Active: {shownValue(field, f.active)}</div>}
      {f.error && <div className="hint bad">{f.error}</div>}
      {f.warning && <div className="hint warn">{f.warning}</div>}
    </div>
  );
}

function WriteStatus({ write }: { write: RecipeWrite }) {
  const what = write.kind === "write" ? "Recipe" : "Program values";
  switch (write.state) {
    case "staged":
      return <p className="muted">{what} staged, waiting for the PLC…</p>;
    case "waiting":
      return <p className="muted">{what} waiting until the machine takes it over…</p>;
    case "applied":
      return <p className="ok">{what} applied.</p>;
    case "rejected":
      return <p className="bad">{`${what} rejected by the PLC${write.message ? `: ${write.message}` : ""}`}</p>;
    case "failed":
      return <p className="bad">{`${what} not written: ${write.message}`}</p>;
  }
}
