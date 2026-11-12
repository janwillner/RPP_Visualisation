import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { COMPONENT_SCHEMAS, type ComponentConfig, type ConveyorConfig, type Draft } from "@rpp/protocol";
import type { SceneFeed } from "../connection";
import { componentKey, type MachineScene } from "../scene/scene-model";
import { SceneView, type CameraPreset, type Layers, type Selection } from "../scene/SceneView";
import type { SourceInfo } from "../sources";
import { download } from "../download";
import { APP_VERSION } from "../version";
import { ViewControls } from "../ViewControls";
import { PALETTE_LABELS, PALETTE_TYPES, placementHeight, type PaletteType } from "./component-defaults";
import { Configurator, DRAFT_FILE_EXTENSION, useConfigurator } from "./configurator";
import { EditControls, type FloorPicker } from "./EditControls";
import { keyOf } from "./edits";
import { properties, type PropertyField, type PropertyGroup } from "./property-fields";

/** Every overlay of the draft is shown: zones, areas and markers are what is being configured. */
const LAYERS: Layers = { workingAreas: true, limitAreas: true, zones: true, tcpMarkers: true, faultLabels: true };
const NO_HIDDEN: ReadonlySet<string> = new Set();
/** MIME type of a palette entry being dragged onto the 3D view. */
const PALETTE_DRAG_TYPE = "application/x-rpp-palette";

/** Text fields and lists keep their keys; a checkbox or a button does not. */
const isTyping = (e: KeyboardEvent) => {
  const target = e.target as HTMLElement | null;
  if (target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable) return true;
  return target instanceof HTMLInputElement && target.type !== "checkbox";
};

/** Saves the draft to a file; a value still being typed is taken first. */
function saveDraft(configurator: Configurator): void {
  (document.activeElement as HTMLElement | null)?.blur();
  const file = configurator.save();
  download(file.text, file.name, "application/json");
}

/** The configurator page (ADR 0016): palette and components on the left, the draft in 3D, its properties on the right. */
export function ConfiguratorApp() {
  const configurator = useMemo(
    () => new Configurator(() => window.confirm("Discard the changes that were not saved?")),
    [],
  );
  const snapshot = useConfigurator(configurator);
  const { draft, selection, issues } = snapshot;
  const modelRef = useRef<MachineScene | undefined>(undefined);
  const floorRef = useRef<FloorPicker | undefined>(undefined);
  const handlePressed = useRef(false);
  const viewportRef = useRef<HTMLElement>(null);
  const [cameraRequest, setCameraRequest] = useState<{ action: CameraPreset; seq: number }>({ action: "iso", seq: 0 });
  const fileInput = useRef<HTMLInputElement>(null);

  // The 3D view reads the draft like a live machine: configuration only, no state.
  const feed = useMemo<SceneFeed>(
    () => ({
      frame: () => configurator.frame(),
      latestState: () => undefined,
      productHistory: () => ({ steps: [], now: 0 }),
      productEvents: () => ({ events: [], now: 0, since: 0 }),
    }),
    [configurator],
  );
  const sources = useMemo<SourceInfo[]>(
    () =>
      configurator.frame().map((s) => ({
        sourceId: s.sourceId,
        name: s.sourceId,
        status: { plcConnected: true },
        config: s.config,
      })),
    // A new draft is a new frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [configurator, draft],
  );
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
    <div className="app configurator">
      <header className="toolbar">
        <strong className="title">RPP Configurator</strong>
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
        <a className="link" href="/">
          Visualisation
        </a>
      </header>

      <aside className="panel left">
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
        <h3>Components</h3>
        {draft.components.length === 0 && <p className="muted">None yet.</p>}
        <ul className="tree">
          {draft.components.map((c, i) => (
            <li key={`${keyOf(c)}:${i}`}>
              <button className={keyOf(c) === selection ? "selected" : ""} onClick={() => configurator.select(keyOf(c))}>
                {c.name} <span className="muted">#{c.id}</span>
              </button>
            </li>
          ))}
        </ul>
        {issues.length > 0 && (
          <>
            <h3>Problems</h3>
            <ul className="issues">
              {issues.map((issue, i) => (
                <li key={i} className={issue.severity === "error" ? "bad" : "warn"}>
                  {issue.message}
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
          feed={feed}
          sources={sources}
          layers={LAYERS}
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
        <ViewControls onCamera={(action) => setCameraRequest((r) => ({ action, seq: r.seq + 1 }))} />
        {snapshot.notice && (
          <div className="recording-notice" role="alert">
            {snapshot.notice} <button onClick={() => configurator.dismissNotice()}>OK</button>
          </div>
        )}
      </main>

      <aside className="panel right">
        {selected ? (
          // Keyed by the component: what a panel holds for one component (a conveyor chosen for a new zone) never
          // carries over to the next.
          <Properties key={keyOf(selected)} component={selected} draft={draft} configurator={configurator} />
        ) : (
          <p className="muted">Select a component to edit its values.</p>
        )}
      </aside>

      <footer className="statusbar">
        <span>Offline draft{snapshot.saved ? "" : " · not saved"}</span>
        <span className="statusbar-version">v{APP_VERSION}</span>
      </footer>
    </div>
  );
}

/** The selected component's values, from its type's schema; every change is one step for undo. */
function Properties(props: { component: ComponentConfig; draft: Draft; configurator: Configurator }) {
  const { component, configurator } = props;
  const key = keyOf(component);
  const description = (COMPONENT_SCHEMAS[component.type].config as { description?: string }).description;
  const { groups, lists } = properties(component);
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
        .filter((g) => !g.entry)
        .map((group) => (
          <fieldset key={group.title || "component"}>
            {group.title && <legend>{group.title}</legend>}
            {fieldsOf(group)}
          </fieldset>
        ))}
      {lists.map((list) => (
        <section key={list.name} className="property-list" aria-label={list.title}>
          <div className="property-list-head" title={list.hint}>
            <h4>{list.title}</h4>
            <AddEntry list={list.name} component={component} conveyors={conveyors} configurator={configurator} />
          </div>
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

/** Adds an entry to a list the configurator knows how to start: a zone on a chosen conveyor, a product type. */
function AddEntry(props: { list: string; component: ComponentConfig; conveyors: ConveyorConfig[]; configurator: Configurator }) {
  const { list, component, conveyors, configurator } = props;
  const key = keyOf(component);
  const [conveyor, setConveyor] = useState<number | undefined>(undefined);
  if (list === "productTypes") return <button onClick={() => configurator.addProductType(key)}>Add product type</button>;
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
