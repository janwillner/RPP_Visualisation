import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { COMPONENT_SCHEMAS, TrackModuleKindSchema, type ComponentConfig, type ConveyorConfig, type Draft, type TrackModuleKind } from "@rpp/protocol";
import {
  APP_VERSION,
  type CameraPreset,
  componentKey,
  type ComponentKey,
  defaultGatewayUrl,
  download,
  GatewayConnection,
  LayerToggles,
  type Layers,
  type MachineScene,
  SceneView,
  type Selection,
  SidePanelControls,
  sidePanelsLayout,
  StatusList,
  TopBar,
  useSidePanel,
  useStore,
  ViewControls,
} from "@rpp/machine-view";
import { GatewayLive } from "./gateway-live";
import { PALETTE_LABELS, PALETTE_TYPES, placementHeight, isAreaField, type PaletteType } from "./component-defaults";
import { Configurator, DRAFT_FILE_EXTENSION, useConfigurator } from "./configurator";
import { EditControls, type FloorPicker } from "./EditControls";
import { FingerLayout } from "./FingerLayout";
import { keyOf } from "./edits";
import type { Match } from "./reconciliation";
import type { Issue } from "./validation";
import type { WriteState } from "./writing";
import { properties, type PropertyField, type PropertyGroup } from "./property-fields";

/** Every overlay of the draft is shown: zones, areas and markers are what is being configured. */
/** Every layer on at the start, the coordinate systems too: origin shifts are set here. */
const LAYERS: Layers = {
  workingAreas: true,
  limitAreas: true,
  zones: true,
  tcpMarkers: true,
  faultLabels: true,
  origins: true,
  marks: true,
};
const NO_HIDDEN: ReadonlySet<string> = new Set();
/** MIME type of a palette entry being dragged onto the 3D view. */
const PALETTE_DRAG_TYPE = "application/x-rpp-palette";

/** Text fields and lists keep their keys; a checkbox or a button does not. */
const isTyping = (e: KeyboardEvent) => {
  const target = e.target as HTMLElement | null;
  if (target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable) return true;
  return target instanceof HTMLInputElement && target.type !== "checkbox";
};

/** How a component's place in the list reads against its PLC; nothing for a draft made offline. */
const MATCH_LABELS: Record<Match, { text: string; title: string } | undefined> = {
  matched: { text: "PLC", title: "The PLC has this component with the same values." },
  changed: { text: "changed", title: "The PLC has this component with other values; writing would change it." },
  draftOnly: { text: "not in PLC", title: "Its PLC has no component with this id." },
  typeMismatch: { text: "other type", title: "Its PLC's component with this id is of another type." },
  noPlc: undefined,
};

function MatchBadge({ match }: { match: Match }) {
  const label = MATCH_LABELS[match];
  if (!label) return null;
  return (
    <span className={`match ${match}`} title={label.title}>
      {label.text}
    </span>
  );
}

/** Saves the draft to a file; a value still being typed is taken first. */
function saveDraft(configurator: Configurator): void {
  (document.activeElement as HTMLElement | null)?.blur();
  const file = configurator.save();
  download(file.text, file.name, "application/json");
}

/** The configurator page (ADR 0016): palette and components on the left, the draft in 3D, its properties on the right. */
export function ConfiguratorApp() {
  // The gateway that served the page: its PLCs are imported from and shown live over the draft (read-only).
  const store = useMemo(() => new GatewayConnection(defaultGatewayUrl()), []);
  const gateway = useStore(store);
  const configurator = useMemo(
    () => new Configurator(() => window.confirm("Discard the changes that were not saved?"), new GatewayLive(store)),
    [store],
  );
  useEffect(() => {
    store.start();
    configurator.start();
    return () => {
      configurator.stop();
      store.stop();
    };
  }, [store, configurator]);
  const snapshot = useConfigurator(configurator);
  const { draft, selection, issues, matches, plcOnly, plcSources } = snapshot;
  const modelRef = useRef<MachineScene | undefined>(undefined);
  const floorRef = useRef<FloorPicker | undefined>(undefined);
  const handlePressed = useRef(false);
  const viewportRef = useRef<HTMLElement>(null);
  const [cameraRequest, setCameraRequest] = useState<{ action: CameraPreset; seq: number }>({ action: "iso", seq: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  /** The source whose write is being confirmed. */
  const [writing, setWriting] = useState<string | undefined>(undefined);
  const [layers, setLayers] = useState<Layers>(LAYERS);
  // Both start open, as the visualisation's; open state and width are remembered on this device.
  const left = useSidePanel("rpp.configurator.panel.left", "Palette and components", () => true);
  const right = useSidePanel("rpp.configurator.panel.right", "Properties", () => true);
  const panels = sidePanelsLayout(left, right);

  const selected = draft.components.find((c) => keyOf(c) === selection);
  const sceneSelection: Selection = selected && { kind: "component", id: selected.id, sourceId: selected.sourceId };

  /** Adds from the palette at a client position, or in the middle of the view. */
  const addAt = (type: PaletteType, clientX?: number, clientY?: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const x = clientX ?? (rect ? rect.left + rect.width / 2 : 0);
    const y = clientY ?? (rect ? rect.top + rect.height / 2 : 0);
    configurator.add(type, floorRef.current?.(x, y, placementHeight(type)) ?? { x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      // Saving works from anywhere, also while typing; the field's own undo keeps its keys.
      if ((e.ctrlKey || e.metaKey) && key === "s") {
        e.preventDefault();
        saveDraft(configurator);
        return;
      }
      if (isTyping(e)) return;
      if ((e.ctrlKey || e.metaKey) && key === "z") configurator[e.shiftKey ? "redo" : "undo"]();
      else if ((e.ctrlKey || e.metaKey) && key === "y") configurator.redo();
      else if (e.ctrlKey || e.metaKey || e.altKey) return;
      else if (key === "delete" && selection) configurator.remove(selection);
      else if (key === "r" && selection) configurator.rotate(selection, e.shiftKey ? -90 : 90);
      else if (key === "escape") configurator.select(undefined);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [configurator, selection]);

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (snapshot.saved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [snapshot.saved]);

  return (
    <div className={["app configurator", panels.className].filter(Boolean).join(" ")} style={panels.style}>
      <TopBar title="RPP Configurator">
        <div className="group">
          <button onClick={() => configurator.newDraft()}>New</button>
          <button onClick={() => fileInput.current?.click()}>Open…</button>
          <button title="Save (Ctrl+S)" onClick={() => saveDraft(configurator)}>
            Save
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={`${DRAFT_FILE_EXTENSION},.json,application/json`}
            hidden
            aria-label="Open a draft file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) configurator.open(await file.text());
            }}
          />
        </div>
        <div className="group">
          <button disabled={!snapshot.canUndo} title="Undo (Ctrl+Z)" onClick={() => configurator.undo()}>
            Undo
          </button>
          <button disabled={!snapshot.canRedo} title="Redo (Ctrl+Y)" onClick={() => configurator.redo()}>
            Redo
          </button>
        </div>
        <label className="group">
          <span className="muted">Machine</span>
          <TextInput value={draft.name} label="Machine name" onCommit={(name) => configurator.rename(name)} />
        </label>
        <LayerToggles layers={layers} onToggle={(key) => setLayers((l) => ({ ...l, [key]: !l[key] }))} />
      </TopBar>

      <aside className="panel left" hidden={!left.open}>
        <h3>Palette</h3>
        <p className="muted">Drag onto the floor, or click to place in the middle of the view.</p>
        <div className="palette">
          {PALETTE_TYPES.map((type) => (
            <button
              key={type}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(PALETTE_DRAG_TYPE, type);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => addAt(type)}
            >
              {PALETTE_LABELS[type]}
            </button>
          ))}
        </div>
        <h3>PLCs</h3>
        {plcSources.length === 0 ? (
          <p className="muted">{gateway.socket === "open" ? "The gateway reads no PLC." : "Not connected to the gateway."}</p>
        ) : (
          <ul className="tree plcs">
            {plcSources.map((s) => (
              <li key={s.sourceId}>
                <span className={s.status?.plcConnected ? "ok" : "warn"} title={s.sourceId}>
                  {s.name}
                </span>
                {/* Below the name: a source name (its AmsNetId and port) leaves no room beside it. */}
                <div className="plc-actions">
                  <button
                    disabled={!s.config}
                    title="Take this PLC's configuration into the draft, in place of the draft's components of this PLC"
                    onClick={() =>
                      configurator.importSource(s.sourceId, (name) =>
                        window.confirm(`Replace the changes to the components of ${name} with what the PLC has?`),
                      )
                    }
                  >
                    Import
                  </button>
                  <WriteButton configurator={configurator} sourceId={s.sourceId} onPlan={() => setWriting(s.sourceId)} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <h3>Components</h3>
        {draft.components.length === 0 && <p className="muted">None yet.</p>}
        <ul className="tree components">
          {draft.components.map((c, i) => (
            <li key={`${keyOf(c)}:${i}`}>
              <button className={keyOf(c) === selection ? "selected" : ""} onClick={() => configurator.select(keyOf(c))}>
                {c.name} <span className="muted">#{c.id}</span>
                <MatchBadge match={matches[keyOf(c)] ?? "noPlc"} />
                <WriteBadge write={snapshot.writes[keyOf(c)]} />
              </button>
            </li>
          ))}
        </ul>
        {plcOnly.length > 0 && (
          <>
            <h3>In the PLC, not in the draft</h3>
            <ul className="tree plc-only">
              {plcOnly.map((c) => (
                <li key={keyOf(c)}>
                  <span>
                    {c.name} <span className="muted">#{c.id}</span>
                  </span>{" "}
                  <button title="Take this component from its PLC into the draft" onClick={() => configurator.importComponent(keyOf(c))}>
                    Add
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>

      <main
        ref={viewportRef}
        className="viewport"
        onContextMenu={(e) => e.preventDefault()}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PALETTE_DRAG_TYPE)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          const type = e.dataTransfer.getData(PALETTE_DRAG_TYPE) as PaletteType;
          if (!PALETTE_TYPES.includes(type)) return;
          e.preventDefault();
          addAt(type, e.clientX, e.clientY);
        }}
      >
        <SceneView
          frame={(now) => configurator.frame(now)}
          layers={layers}
          selection={sceneSelection}
          onSelect={(s) => {
            // A tap on the move handle is no tap on empty space.
            if (!s && handlePressed.current) return;
            configurator.select(s?.kind === "component" ? componentKey(s.sourceId, s.id) : undefined);
          }}
          cameraRequest={cameraRequest}
          modelRef={modelRef}
          measureMode={false}
          onMeasure={() => {}}
          measurePoints={[]}
          hidden={NO_HIDDEN}
          onFaults={() => {}}
        >
          <EditControls
            configurator={configurator}
            draft={draft}
            selection={selection}
            modelRef={modelRef}
            floorRef={floorRef}
            pressedRef={handlePressed}
          />
        </SceneView>
        <SidePanelControls left={left} right={right} />
        <ViewControls onCamera={(action) => setCameraRequest((r) => ({ action, seq: r.seq + 1 }))} />
        {snapshot.notice && (
          <div className="recording-notice" role="alert">
            {snapshot.notice} <button onClick={() => configurator.dismissNotice()}>OK</button>
          </div>
        )}
      </main>

      <aside className="panel right" hidden={!right.open}>
        {selected ? (
          // Keyed by the component: what a panel holds for one component (a conveyor chosen for a new zone) never
          // carries over to the next.
          <Properties
            key={keyOf(selected)}
            component={selected}
            draft={draft}
            configurator={configurator}
            hardwareDiffers={issues.some((i) => i.hardware && i.key === keyOf(selected))}
            activeVersion={
              snapshot.plcParameters[selected.sourceId]?.components.find((p) => p.id === selected.id)?.activeVersion
            }
          />
        ) : (
          <p className="muted">Select a component to edit its values.</p>
        )}
      </aside>

      {writing && (
        <WriteDialog
          configurator={configurator}
          sourceId={writing}
          sourceName={plcSources.find((s) => s.sourceId === writing)?.name ?? writing}
          onClose={() => setWriting(undefined)}
        />
      )}

      <footer className="statusbar">
        <span>
          {plcSources.length > 0 ? `Gateway: ${gateway.socket} · ${plcSources.length} PLC` : "Offline draft"}
          {snapshot.saved ? "" : " · not saved"}
        </span>
        <StatusList
          className="problems"
          noun={["problem", "problems"]}
          items={issues.map((issue) => ({
            text: issue.message,
            severity: issue.severity === "error" ? "error" : "warning",
            onSelect: () => configurator.select(issue.key),
          }))}
        />
        <span className="statusbar-version">v{APP_VERSION}</span>
      </footer>
    </div>
  );
}

/** The selected component's values, from its type's schema; every change is one step for undo. */
function Properties(props: {
  component: ComponentConfig;
  draft: Draft;
  configurator: Configurator;
  hardwareDiffers: boolean;
  /** Version of the component's active parameter set in its PLC; undefined without Syn_Config. */
  activeVersion: number | undefined;
}) {
  const { component, configurator } = props;
  const key = keyOf(component);
  const description = (COMPONENT_SCHEMAS[component.type].config as { description?: string }).description;
  const { groups, lists, optionals } = properties(component);
  // A zone lies on a conveyor of the component's own source.
  const conveyors = props.draft.components.filter(
    (c): c is ConveyorConfig => c.type === "conveyor" && c.sourceId === component.sourceId,
  );
  const commit = (path: string[]) => (value: unknown) => configurator.set(key, path, value);
  const fieldsOf = (group: PropertyGroup) =>
    group.fields.map((field) => (
      <Field key={field.path.join(".")} field={field} conveyors={conveyors} onCommit={commit(field.path)} />
    ));
  return (
    <div className="properties">
      <h3 title={description}>{component.name}</h3>
      {props.activeVersion !== undefined && (
        <p className="muted">
          {props.activeVersion > 0 ? `Parameter set v${props.activeVersion} active in the PLC.` : "The PLC runs its program values."}{" "}
          {props.activeVersion > 0 && (
            <button
              onClick={() => {
                if (window.confirm(`Return ${component.name} to its program values in the PLC?`)) void configurator.resetParameters(key);
              }}
            >
              Reset to program values
            </button>
          )}
        </p>
      )}
      {props.hardwareDiffers && (
        <p className="warn">
          The PLC has other hardware for this component.{" "}
          <button onClick={() => configurator.adoptPlcHardware(key)}>Take hardware from PLC</button>
        </p>
      )}
      <div className="group">
        <button title="Turn 90° clockwise (Shift+R)" onClick={() => configurator.rotate(key, -90)}>
          ↻ 90°
        </button>
        <button title="Turn 90° counter-clockwise (R)" onClick={() => configurator.rotate(key, 90)}>
          ↺ 90°
        </button>
        <button title="Remove (Delete)" onClick={() => configurator.remove(key)}>
          Remove
        </button>
      </div>
      {groups
        .filter((g) => !g.entry && !g.optional)
        .map((group) => (
          <fieldset key={group.title || "component"}>
            {group.title && <legend>{group.title}</legend>}
            {fieldsOf(group)}
          </fieldset>
        ))}
      {optionals.map((optional) => {
        const group = groups.find((g) => g.optional === optional.name);
        const field = optional.name;
        // Only the areas have an editor yet; another optional value would need its own default.
        if (!isAreaField(field)) return null;
        if (!group) {
          return (
            <div key={optional.name} className="property-list-head" title={optional.hint}>
              <h4>{optional.title}</h4>
              <button onClick={() => configurator.addArea(key, field)}>Add {inSentence(optional.title)}</button>
            </div>
          );
        }
        return (
          <fieldset key={optional.name} aria-label={optional.title} title={optional.hint}>
            <legend>
              {optional.title}{" "}
              <button className="link-button" title={`Remove ${inSentence(optional.title)}`} onClick={() => configurator.removeArea(key, field)}>
                Remove
              </button>
            </legend>
            {fieldsOf(group)}
          </fieldset>
        );
      })}
      {lists.map((list) => (
        <section key={list.name} className="property-list" aria-label={list.title}>
          <div className="property-list-head" title={list.hint}>
            <h4>{list.title}</h4>
            <AddEntry list={list.name} component={component} conveyors={conveyors} configurator={configurator} />
          </div>
          {list.name === "fingers" && "fingers" in component && component.fingers.length > 0 && (
            <FingerLayout
              fingers={component.fingers}
              onBegin={() => configurator.beginGesture()}
              onMove={(index, at) => configurator.moveFinger(key, index, at)}
              onEnd={() => configurator.endGesture()}
            />
          )}
          {groups
            .filter((g) => g.entry?.list === list.name)
            .map((group) => (
              <fieldset key={group.title} aria-label={group.title}>
                <legend>
                  {group.title}{" "}
                  <button
                    className="link-button"
                    title={`Remove ${group.title.toLowerCase()}`}
                    onClick={() => configurator.removeListEntry(key, list.name, group.entry!.index)}
                  >
                    Remove
                  </button>
                </legend>
                {fieldsOf(group)}
              </fieldset>
            ))}
        </section>
      ))}
    </div>
  );
}

/** A label inside a sentence: "Limit area" → "limit area", "TCP limit area" stays. */
const inSentence = (title: string) => (/^[A-Z][a-z]/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title);

/**
 * Adds an entry to a list the configurator knows how to start: a zone on a chosen conveyor, a product type, a track
 * module of a chosen kind, a body, a finger.
 */
function AddEntry(props: { list: string; component: ComponentConfig; conveyors: ConveyorConfig[]; configurator: Configurator }) {
  const { list, component, conveyors, configurator } = props;
  const key = keyOf(component);
  const [conveyor, setConveyor] = useState<number | undefined>(undefined);
  const [moduleKind, setModuleKind] = useState<TrackModuleKind>("straight");
  if (list === "productTypes") return <button onClick={() => configurator.addProductType(key)}>Add product type</button>;
  if (list === "bodies") return <button onClick={() => configurator.addBody(key)}>Add body</button>;
  if (list === "fingers") return <button onClick={() => configurator.addFinger(key)}>Add finger</button>;
  if (list === "modules") {
    return (
      <span className="group">
        <select aria-label="Kind of the new module" value={moduleKind} onChange={(e) => setModuleKind(e.target.value as TrackModuleKind)}>
          {TrackModuleKindSchema.options.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <button onClick={() => configurator.addModule(key, moduleKind)}>Add module</button>
      </span>
    );
  }
  if (list !== "zones") return null;
  if (conveyors.length === 0) return <span className="muted">No conveyor in this source</span>;
  const chosen = conveyors.find((c) => c.id === conveyor) ?? conveyors[0]!;
  return (
    <span className="group">
      <select aria-label="Conveyor of the new zone" value={chosen.id} onChange={(e) => setConveyor(Number(e.target.value))}>
        {conveyors.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button onClick={() => configurator.addZone(key, componentKey(chosen.sourceId, chosen.id))}>Add zone</button>
    </span>
  );
}

function Field(props: { field: PropertyField; conveyors: ConveyorConfig[]; onCommit: (value: unknown) => void }) {
  const { field, onCommit } = props;
  const label = field.kind === "number" && field.unit ? `${field.label} [${field.unit}]` : field.label;
  // A zone names its conveyor by manifest id: chosen from the conveyors of the source.
  if (field.kind === "number" && field.key === "conveyorId") {
    const known = props.conveyors.some((c) => c.id === field.value);
    return (
      <label className="property" title={field.hint}>
        <span>Conveyor</span>
        <select aria-label="Conveyor" value={field.value} onChange={(e) => onCommit(Number(e.target.value))}>
          {!known && <option value={field.value}>#{field.value} (unknown)</option>}
          {props.conveyors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="property" title={field.hint}>
      <span>{label}</span>
      {field.kind === "number" && (
        <NumberInput value={field.value} integer={field.integer} label={field.label} onCommit={onCommit} />
      )}
      {field.kind === "text" && <TextInput value={field.value} label={field.label} onCommit={onCommit} />}
      {field.kind === "switch" && (
        <input type="checkbox" aria-label={field.label} checked={field.value} onChange={(e) => onCommit(e.target.checked)} />
      )}
      {field.kind === "choice" && (
        <select aria-label={field.label} value={field.value} onChange={(e) => onCommit(e.target.value)}>
          {field.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )}
    </label>
  );
}

/** Commits on Enter or when it loses focus, so typing a number is one step for undo; Escape restores the value. */
function useDraftText(value: string, commit: (text: string) => void) {
  const [text, setText] = useState(value);
  // Set by Escape: the blur that follows at once must not commit what was typed.
  const cancelled = useRef(false);
  useEffect(() => setText(value), [value]);
  return {
    value: text,
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: () => {
      if (!cancelled.current && text !== value) commit(text);
      cancelled.current = false;
      // Shown as the value is, also when the text meant the same (2000.0) or was refused; a changed value follows.
      setText(value);
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") e.currentTarget.blur();
      if (e.key === "Escape") {
        cancelled.current = true;
        e.currentTarget.blur();
      }
    },
  };
}

function NumberInput(props: { value: number; integer: boolean; label: string; onCommit: (value: number) => void }) {
  const input = useDraftText(String(props.value), (text) => {
    const n = Number(text.replace(",", "."));
    if (text.trim() !== "" && Number.isFinite(n) && (!props.integer || Number.isInteger(n))) props.onCommit(n);
  });
  return <input type="text" inputMode="decimal" aria-label={props.label} {...input} />;
}

function TextInput(props: { value: string; label: string; onCommit: (value: string) => void }) {
  const input = useDraftText(props.value, props.onCommit);
  return <input type="text" aria-label={props.label} {...input} />;
}


/** Opens the confirmation of a write to one PLC; disabled with the reason while it cannot be written. */
function WriteButton(props: { configurator: Configurator; sourceId: string; onPlan: () => void }) {
  const plan = props.configurator.writePlan(props.sourceId);
  const nothing = plan.changes.length === 0;
  const idle = plan.unwritable
    ? `The draft changes nothing this PLC can take: ${unwritableText(plan.unwritable)}.`
    : "The draft changes nothing on this PLC.";
  return (
    <button
      disabled={plan.blocked !== undefined || nothing}
      title={plan.blocked ?? (nothing ? idle : "Write the draft's changes to this PLC")}
      onClick={props.onPlan}
    >
      Write…
    </button>
  );
}

/** Names the changed components a PLC has no parameter set for, e.g. "Delta 2 and Delta 3 have no parameter set". */
function unwritableText(names: readonly string[]): string {
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? "has" : "have"} no parameter set on it`;
}

/** What a write to one PLC changes, old and new value by value; it is sent only after confirming. */
function WriteDialog(props: { configurator: Configurator; sourceId: string; sourceName: string; onClose: () => void }) {
  const plan = props.configurator.writePlan(props.sourceId);
  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="dialog" role="dialog" aria-label={`Write to ${props.sourceName}`} onClick={(e) => e.stopPropagation()}>
        <h3>Write to {props.sourceName}</h3>
        {plan.blocked && <p className="bad">{plan.blocked}</p>}
        {plan.changes.map((change) => (
          <section key={change.key}>
            <h4>{change.name}</h4>
            <table className="changes">
              <tbody>
                {change.fields.map((f) => (
                  <tr key={f.path}>
                    <td>{f.path}</td>
                    <td className="muted">{f.from}</td>
                    <td>→</td>
                    <td>{f.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        {plan.unwritable && <p className="warn">Not written: {unwritableText(plan.unwritable)}.</p>}
        <p className="muted">
          The PLC takes each set over when its application allows it, e.g. while the machine stands.
        </p>
        <div className="group">
          <button
            disabled={plan.blocked !== undefined || plan.changes.length === 0}
            onClick={() => {
              void props.configurator.write(props.sourceId);
              props.onClose();
            }}
          >
            Write
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const WRITE_LABELS: Record<WriteState["state"], string> = {
  staged: "sent",
  waiting: "waiting for PLC",
  applied: "written",
  rejected: "rejected",
  failed: "not sent",
};

function WriteBadge({ write }: { write: WriteState | undefined }) {
  if (!write) return null;
  const message = "message" in write ? write.message : undefined;
  return (
    <span className={`write ${write.state}`} title={message}>
      {WRITE_LABELS[write.state]}
    </span>
  );
}
