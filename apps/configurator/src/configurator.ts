import { useSyncExternalStore } from "react";
import { DRAFT_FILE_FORMAT_VERSION, DraftSchema, PROTOCOL_VERSION, emptyDraft, type TrackModuleKind, type ClientMessage, type ComponentConfig, type ConfigMessage, type ParametersMessage, type WriteResultMessage, type ConveyorConfig, type ConveyorState, type Draft, type ProductType, type StateMessage, type Zone } from "@rpp/protocol";
import { componentKey, type ComponentKey, type SceneSource, type SourceInfo, zoneSides } from "@rpp/machine-view";
import { beltRange, mcsToBelt } from "./belt-coordinates";
import { defaultArea, defaultComponent, newBody, newFinger, HARDWARE_FIELDS, PALETTE_LABELS, XTS_MODULE_LENGTH, type AreaField, type PaletteType } from "./component-defaults";
import { applyEdit, keyOf, type Edit } from "./edits";
import { hardwareHints, reconcile, type Match, type Reconciliation } from "./reconciliation";
import { validateDraft, type Issue } from "./validation";
import { restState } from "./rest-states";
import {
  followWrites,
  parameterSetOf,
  unwritableHints,
  wiringHints,
  writePlan,
  type WritePlan,
  type WriteState,
} from "./writing";

/**
 * The configurator (ADR 0016): the draft of a machine being edited, the commands that edit it, undo and redo, and the
 * draft file. The 3D view reads the draft through `frame`, drawn by the same kits as the live machine.
 */

/** The source of components placed offline, until they are given the source of a PLC. */
export const DRAFT_SOURCE = "draft";

/** The source a PLC's version of changed components is drawn in, faded, beside the draft (ADR 0016). */
export const ghostSourceId = (sourceId: string) => `${sourceId} (PLC)`;

const NO_PARAMETERS: Readonly<Record<string, ParametersMessage>> = {};

/** Positions are placed on this grid, mm. */
export const GRID_MM = 10;

/** An edge of a zone that can be dragged: along the belt its start, end and CCS, across it its two sides. */
export type ZoneEdge = "start" | "end" | "ccs" | "left" | "right";

/** Fingers are dragged over the flange's top view on this grid, mm. */
export const FINGER_GRID_MM = 5;

/** Distance of a new finger from the furthest one along the flange's X, mm. */
const FINGER_SPACING = 60;

/** Length of a new zone along its belt, mm. */
const ZONE_LENGTH = 500;

/** Extension of a saved draft file. */
export const DRAFT_FILE_EXTENSION = ".rpp-draft.json";

/** `v` on a grid of `grid` mm, by default the placement grid. */
const snap = (v: number, grid = GRID_MM) => Math.round(v / grid) * grid;

export interface ConfiguratorSnapshot {
  draft: Draft;
  /** The selected component, shown in the property panel. */
  selection: ComponentKey | undefined;
  canUndo: boolean;
  canRedo: boolean;
  /** False while the draft has changes that were not saved to a file. */
  saved: boolean;
  /** What is wrong with the draft: errors keep it from being written to a PLC. */
  issues: Issue[];
  /** Set when something could not be done, e.g. a file could not be opened. */
  notice: string | undefined;
  /** The PLC sources the gateway reads, with their configuration; empty without a gateway. */
  plcSources: readonly SourceInfo[];
  /** How each of the draft's components stands against its PLC, by component key. */
  matches: Record<ComponentKey, Match>;
  /** The PLCs' components the draft does not have. */
  plcOnly: ComponentConfig[];
  /** Per source the parameter sets of its PLC (ADR 0017); a source without Syn_Config has none. */
  plcParameters: Readonly<Record<string, ParametersMessage>>;
  /** Per component how its last write fares. */
  writes: Readonly<Record<ComponentKey, WriteState>>;
}

/**
 * The gateway as the configurator reads it (ADR 0016): the PLC sources with their configuration and their live state.
 * `GatewayLive` in the app, a fake in tests.
 */
export interface ConfiguratorLive {
  /** The sources, and per source its parameter sets (ADR 0017) when its PLC has Syn_Config. */
  getSnapshot(): { sources: readonly SourceInfo[]; parameters?: Readonly<Record<string, ParametersMessage>> };
  subscribe(listener: () => void): () => void;
  /** Every source as the machine scene takes it, at `now` (performance.now()). */
  frame(now?: number): SceneSource[];
  /** Sends a command on parameter sets to the gateway and gives its answer. */
  command?(command: ClientMessage): Promise<WriteResultMessage>;
}

/** A draft as a file to save. */
export interface DraftFile {
  text: string;
  name: string;
}

/** The value at `path` below `target`. */
function valueAt(target: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], target);
}

/** Equal values: the same JSON (configurations are plain data). */
const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Drafts kept for undo. */
const UNDO_LIMIT = 200;

export class Configurator {
  private snapshot: ConfiguratorSnapshot;
  /** Drafts before the current one, oldest first, and those undone, the most recently undone last. */
  private readonly undoStack: Draft[] = [];
  private readonly redoStack: Draft[] = [];
  /** The gesture in progress and the draft it started from. */
  private gesture: { start: Draft } | undefined;
  /** The draft as last saved or opened; the draft is saved while it is this very object. */
  private savedDraft: Draft;
  private readonly listeners = new Set<() => void>();
  private framed: { draft: Draft; sources: SceneSource[] } | undefined;
  private stopLive: (() => void) | undefined;
  /** Request ids of this configurator's commands. */
  private nextRequest = 1;
  private reconciliation: Reconciliation = { matches: {}, plcOnly: [], plc: new Map() };
  /** The problems of the draft itself, found again only when it changes. */
  private draftIssues: Issue[] = [];
  private ghosts: { reconciliation: Reconciliation; sources: SceneSource[] } | undefined;
  /** Live states cut to the components shown, per reconciliation (its matches) and state message. */
  private readonly liveStates = new WeakMap<Record<ComponentKey, Match>, WeakMap<StateMessage, StateMessage>>();

  /**
   * `confirmDiscard` asks whether unsaved changes may be discarded for a new or opened draft; `live` is the gateway,
   * none for a configurator that works offline only.
   */
  constructor(
    private readonly confirmDiscard: () => boolean = () => true,
    private readonly live?: ConfiguratorLive,
  ) {
    this.savedDraft = emptyDraft();
    this.snapshot = {
      draft: this.savedDraft,
      selection: undefined,
      canUndo: false,
      canRedo: false,
      saved: true,
      issues: [],
      notice: undefined,
      plcSources: [],
      matches: {},
      plcOnly: [],
      plcParameters: {},
      writes: {},
    };
  }

  // Writing to a PLC (ADR 0017).

  /** What writing the draft to `sourceId`'s PLC would change, or why it cannot be written. */
  writePlan(sourceId: string): WritePlan {
    const { draft, issues, plcParameters } = this.snapshot;
    return writePlan(draft, issues, plcParameters, this.reconciliation.plc, sourceId);
  }

  /**
   * Writes every component of `sourceId` whose parameter set the draft changes, each on the active version it is
   * based on; `writes` then follows each until its PLC handled it. Nothing when the source cannot be written.
   */
  async write(sourceId: string): Promise<void> {
    const plan = this.writePlan(sourceId);
    const status = this.snapshot.plcParameters[sourceId];
    if (plan.blocked || !status) return;
    await Promise.all(
      plan.changes.map(async ({ key }) => {
        const c = this.component(key);
        const set = c && parameterSetOf(c);
        const baseVersion = status.components.find((p) => p.id === c?.id)?.activeVersion;
        if (!c || !set || baseVersion === undefined) return;
        await this.send(key, { kind: "writeParameters", requestId: this.nextRequest++, sourceId, componentId: c.id, baseVersion, set });
      }),
    );
  }

  /** Makes a component's active parameter set invalid, so its application's program values apply again. */
  async resetParameters(key: ComponentKey): Promise<void> {
    const c = this.component(key);
    const baseVersion = c && this.snapshot.plcParameters[c.sourceId]?.components.find((p) => p.id === c.id)?.activeVersion;
    if (!c || baseVersion === undefined) return;
    await this.send(key, { kind: "resetParameters", requestId: this.nextRequest++, sourceId: c.sourceId, componentId: c.id, baseVersion });
  }

  private async send(key: ComponentKey, command: ClientMessage): Promise<void> {
    if (!this.live?.command) return;
    let write: WriteState;
    try {
      const answer = await this.live.command(command);
      write = answer.ok && answer.stageId !== undefined
        ? { state: "staged", stageId: answer.stageId }
        : { state: "failed", message: answer.error ?? "The gateway refused the command." };
    } catch (error) {
      write = { state: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    this.set_({ writes: followWrites({ ...this.snapshot.writes, [key]: write }, this.snapshot.plcParameters) });
  }

  /** Takes a matched component's hardware (`HARDWARE_FIELDS`) from its PLC: one step for undo. */
  adoptPlcHardware(key: ComponentKey): void {
    const theirs = this.reconciliation.plc.get(key) as Record<string, unknown> | undefined;
    const ours = this.component(key);
    if (!theirs || !ours) return;
    this.beginGesture();
    for (const field of HARDWARE_FIELDS[ours.type] as readonly string[]) this.set(key, [field], theirs[field]);
    this.endGesture();
  }

  /** Takes one component the PLC has and the draft has not into the draft. */
  importComponent(key: ComponentKey): void {
    const component = this.snapshot.plcOnly.find((c) => keyOf(c) === key);
    if (component) this.edit({ kind: "add", component });
  }

  /** Starts following the gateway's sources. */
  start(): void {
    if (!this.live || this.stopLive) return;
    const follow = () => {
      const { sources, parameters = NO_PARAMETERS } = this.live!.getSnapshot();
      // The gateway also tells of its socket; only a change of the sources or parameter sets concerns the configurator.
      if (sources === this.snapshot.plcSources && parameters === this.snapshot.plcParameters) return;
      this.set_({
        plcSources: sources,
        plcParameters: parameters,
        writes: followWrites(this.snapshot.writes, parameters),
      });
    };
    this.stopLive = this.live.subscribe(follow);
    follow();
  }

  stop(): void {
    this.stopLive?.();
    this.stopLive = undefined;
  }

  /**
   * Takes a PLC source's configuration into the draft, in place of the draft's components of that source: one step
   * for undo.
   */
  importSource(sourceId: string, confirm: (sourceName: string) => boolean = () => true): void {
    const source = this.snapshot.plcSources.find((s) => s.sourceId === sourceId);
    if (!source?.config) return;
    // The draft's own changes to that PLC's components are lost by the import: asked first.
    const { draft, matches } = this.snapshot;
    const changed = draft.components.some((c) => c.sourceId === sourceId && matches[keyOf(c)] !== "matched");
    if (changed && !confirm(source.name)) return;
    this.edit({ kind: "replaceSource", sourceId, components: source.config.components });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  // Edits.

  /** Adds a component of `type` from the palette at (x, y) on the floor plane, MCS mm, and selects it. */
  add(type: PaletteType, at: { x: number; y: number }): void {
    const { components } = this.snapshot.draft;
    const id = 1 + Math.max(0, ...components.filter((c) => c.sourceId === DRAFT_SOURCE).map((c) => c.id));
    const name = `${PALETTE_LABELS[type]} ${id}`;
    const component = defaultComponent(type, { id, sourceId: DRAFT_SOURCE, name }, { x: snap(at.x), y: snap(at.y) });
    this.edit({ kind: "add", component }, keyOf(component));
  }

  /** Sets one value of a component, found by its path of field names, e.g. `["pose", "rz"]`. */
  set(key: ComponentKey, path: readonly string[], value: unknown): void {
    const index = this.snapshot.draft.components.findIndex((c) => keyOf(c) === key);
    if (index < 0) return;
    // A value written again unchanged is no change: no undo step, still saved.
    if (sameValue(valueAt(this.snapshot.draft.components[index], path), value)) return;
    const { selection } = this.snapshot;
    this.edit({ kind: "set", key, path, value });
    // A new id or source is a new key: the selection follows the component.
    if (selection === key) this.select(keyOf(this.snapshot.draft.components[index]!));
  }

  /**
   * Adds a zone to a robot, detector or station on a conveyor of the same source: the middle 500 mm of the belt (all
   * of it when shorter), across the whole width, its CCS at the zone start.
   */
  addZone(ownerKey: ComponentKey, conveyorKey: ComponentKey): void {
    const owner = this.component(ownerKey);
    const belt = this.component(conveyorKey);
    if (!owner || !("zones" in owner) || belt?.type !== "conveyor") return;
    if (belt.sourceId !== owner.sourceId) {
      this.set_({ notice: `A zone lies on a conveyor of the same PLC: ${belt.name} belongs to another source.` });
      return;
    }
    const range = beltRange(belt);
    const middle = (range.start + range.end) / 2;
    const half = Math.min(ZONE_LENGTH, belt.length) / 2;
    // On the grid, but never past the belt, whose ends need not be on the grid.
    const onBelt = (v: number) => Math.min(range.end, Math.max(range.start, snap(v)));
    const zone: Zone = {
      conveyorId: belt.id,
      start: onBelt(middle - half),
      end: onBelt(middle + half),
      allocationOffset: 0,
      ccsOffset: onBelt(middle - half),
      startY: 0,
      endY: 0,
    };
    this.set(ownerKey, ["zones"], [...owner.zones, zone]);
  }

  /**
   * Moves one edge of a zone to the point of the 3D view over its belt (MCS mm), on the grid in belt coordinates:
   * its start, end or CCS along the belt, or its left (+Y) or right side across it. A zone over the whole width gets
   * its other side at the belt edge.
   */
  dragZone(ownerKey: ComponentKey, index: number, edge: ZoneEdge, at: { x: number; y: number; z?: number }): void {
    const owner = this.component(ownerKey);
    const zone = owner && "zones" in owner ? owner.zones[index] : undefined;
    const belt = zone && this.conveyor(owner!.sourceId, zone.conveyorId);
    if (!zone || !belt) return;
    const point = mcsToBelt(belt, at);
    const x = snap(point.x);
    const y = snap(point.y);
    const lane = zoneSides(zone, belt);
    // A side stays at least one grid step beside the other, so the lane neither collapses nor flips over.
    const changes: Partial<Zone> =
      edge === "start" ? { start: x }
      : edge === "end" ? { end: x }
      : edge === "ccs" ? { ccsOffset: x }
      : edge === "left" ? { startY: Math.max(y, lane.right + GRID_MM), endY: lane.right }
      : { startY: lane.left, endY: Math.min(y, lane.left - GRID_MM) };
    this.set(ownerKey, ["zones", String(index)], { ...zone, ...changes });
  }

  /** Adds a 250 mm track module of `kind` at the end of an XTS track. */
  addModule(key: ComponentKey, kind: TrackModuleKind): void {
    const track = this.component(key);
    if (track?.type !== "xtsGantry" && track?.type !== "xtsLoop") return;
    this.set(key, ["modules"], [...track.modules, { kind, length: XTS_MODULE_LENGTH }]);
  }

  /** Adds a body to a detector or station: a 100 mm box standing on its origin, to edit from there. */
  addBody(key: ComponentKey): void {
    const c = this.component(key);
    if (!c || !("bodies" in c)) return;
    this.set(key, ["bodies"], [...c.bodies, newBody()]);
  }

  /**
   * Adds a finger to a robot's gripper (ADR 0018): `newFinger`, on the flange centre for the first one and each next
   * one FINGER_SPACING further along the flange's X than the furthest so far.
   */
  addFinger(key: ComponentKey): void {
    const c = this.component(key);
    if (!c || !("fingers" in c)) return;
    const x = c.fingers.length === 0 ? 0 : Math.max(...c.fingers.map((f) => f.offset.x)) + FINGER_SPACING;
    this.set(key, ["fingers"], [...c.fingers, newFinger(x)]);
  }

  /** Moves finger `index` to (x, y) in the flange's top view, mm, on a FINGER_GRID_MM grid; its Z and Rz stay. */
  moveFinger(key: ComponentKey, index: number, at: { x: number; y: number }): void {
    const c = this.component(key);
    const finger = c && "fingers" in c ? c.fingers[index] : undefined;
    if (!finger) return;
    const offset = { ...finger.offset, x: snap(at.x, FINGER_GRID_MM), y: snap(at.y, FINGER_GRID_MM) };
    this.set(key, ["fingers", String(index), "offset"], offset);
  }

  /** Gives a robot a limit area or a TCP limit area it does not have yet, starting as `defaultArea`. */
  addArea(key: ComponentKey, field: AreaField): void {
    const c = this.component(key);
    if (!c || !("limitArea" in c) || c[field] !== null) return;
    this.set(key, [field], defaultArea(c, field));
  }

  /** Removes a robot's limit area or TCP limit area. */
  removeArea(key: ComponentKey, field: AreaField): void {
    const c = this.component(key);
    if (!c || !("limitArea" in c)) return;
    this.set(key, [field], null);
  }

  /** Removes the entry at `index` of one of a component's lists, e.g. a zone or a product type. */
  removeListEntry(key: ComponentKey, list: string, index: number): void {
    const entries = (this.component(key) as Record<string, unknown> | undefined)?.[list];
    if (!Array.isArray(entries) || index < 0 || index >= entries.length) return;
    this.set(key, [list], entries.filter((_, i) => i !== index));
  }

  remove(key: ComponentKey): void {
    if (!this.component(key)) return;
    this.edit({ kind: "remove", key });
  }

  /** Names the machine; the saved file is named after it. */
  rename(name: string): void {
    if (name === this.snapshot.draft.name) return;
    this.edit({ kind: "rename", name });
  }

  /**
   * Moves a component to (x, y), keeping its height; MCS mm. On the grid unless `onGrid` is false: a component caught
   * by another one's snap point goes exactly there.
   */
  moveTo(key: ComponentKey, at: { x: number; y: number }, { onGrid = true } = {}): void {
    const pose = this.component(key)?.pose;
    if (!pose) return;
    const x = onGrid ? snap(at.x) : at.x;
    const y = onGrid ? snap(at.y) : at.y;
    if (x === pose.x && y === pose.y) return;
    this.edit({ kind: "set", key, path: ["pose"], value: { ...pose, x, y } });
  }

  /** Turns a component about its vertical axis by `degrees`; its rotation stays within 0° to 360°. */
  rotate(key: ComponentKey, degrees: number): void {
    const rz = this.component(key)?.pose.rz;
    if (rz === undefined) return;
    this.set(key, ["pose", "rz"], (((rz + degrees) % 360) + 360) % 360);
  }

  /**
   * Between `beginGesture` and `endGesture` (a drag in the 3D view), every edit together is one step for undo. A
   * gesture that ends where it started leaves none.
   */
  beginGesture(): void {
    this.gesture = { start: this.snapshot.draft };
  }

  endGesture(): void {
    const start = this.gesture?.start;
    this.gesture = undefined;
    if (!start || start === this.snapshot.draft || !sameValue(start, this.snapshot.draft)) return;
    // Back where it started: its undo step goes, and the draft is the one from before, saved if that was.
    this.undoStack.pop();
    this.show(start);
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.snapshot.draft);
    this.show(previous);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot.draft);
    this.show(next);
  }

  /** Selects a component for the property panel; undefined selects none. */
  select(selection: ComponentKey | undefined): void {
    // Only the draft's components: not a ghost of the PLC's version.
    if (selection === this.snapshot.selection || (selection !== undefined && !this.component(selection))) return;
    this.set_({ selection });
  }

  // Files.

  /** Starts an empty draft; unsaved changes are discarded only after `confirmDiscard`. */
  newDraft(): void {
    if (!this.replaceAllowed()) return;
    this.replace(emptyDraft());
  }

  /** The draft as a file to save; from now on it counts as saved. */
  save(): DraftFile {
    const { draft } = this.snapshot;
    this.savedDraft = draft;
    this.set_({ saved: true });
    return { text: `${JSON.stringify(draft, null, 2)}\n`, name: `${draft.name || "Machine"}${DRAFT_FILE_EXTENSION}` };
  }

  /** Opens a saved draft in place of the shown one; unsaved changes are discarded only after `confirmDiscard`. */
  open(text: string): void {
    let draft: Draft;
    try {
      draft = DraftSchema.parse(upgradeDraft(JSON.parse(text)));
    } catch {
      this.set_({ notice: "The file is not a draft of this configurator, or it is damaged." });
      return;
    }
    if (draft.formatVersion > DRAFT_FILE_FORMAT_VERSION || draft.protocolVersion > PROTOCOL_VERSION) {
      this.set_({ notice: "The draft was saved by a newer configurator; update this one to open it." });
      return;
    }
    // An older draft whose components still read as this protocol's is taken over as one.
    draft = { ...draft, formatVersion: DRAFT_FILE_FORMAT_VERSION, protocolVersion: PROTOCOL_VERSION };
    if (!this.replaceAllowed()) return;
    this.replace(draft);
  }

  dismissNotice(): void {
    if (this.snapshot.notice !== undefined) this.set_({ notice: undefined });
  }

  // The 3D view.

  /** Every source of the draft as the machine scene takes it: its configuration, no state. Same array per draft. */
  frame(now = performance.now()): SceneSource[] {
    const own = this.draftSources();
    const ghosts = this.ghostSources();
    if (!this.live || this.snapshot.plcSources.length === 0) return ghosts.length === 0 ? own : [...own, ...ghosts];
    // Over the draft, the live states of the components its PLC has (ADR 0016): set zones against real products.
    const live = new Map(this.live.frame(now).map((s) => [s.sourceId, s]));
    const { matches } = this.snapshot;
    const withLive = own.map((source) => {
      const theirs = live.get(source.sourceId);
      // While the PLC is offline its last states are no longer live: the draft is shown on its own.
      if (!theirs?.online || theirs.snapshots.length === 0) return source;
      const snapshots = theirs.snapshots.map((s) => this.liveState(s, matches));
      return { ...source, snapshots, renderTime: theirs.renderTime };
    });
    return [...withLive, ...ghosts];
  }

  /** A live state with only the states of components the draft has as the PLC does (same id and type). */
  private liveState(state: StateMessage, matches: Record<ComponentKey, Match>): StateMessage {
    let cache = this.liveStates.get(matches);
    if (!cache) this.liveStates.set(matches, (cache = new WeakMap()));
    let kept = cache.get(state);
    if (!kept) {
      const shown = (id: number) => {
        const match = matches[componentKey(state.sourceId, id)];
        return match === "matched" || match === "changed";
      };
      kept = { ...state, components: state.components.filter((c) => shown(c.id)) };
      cache.set(state, kept);
    }
    return kept;
  }

  /**
   * The PLC's version of every component the draft changed, as a source of its own the 3D view draws faded (it is
   * never online), so the change shows next to what the PLC has now.
   */
  private ghostSources(): SceneSource[] {
    const reconciliation = this.reconciliation;
    if (this.ghosts?.reconciliation === reconciliation) return this.ghosts.sources;
    const bySource = new Map<string, ComponentConfig[]>();
    for (const [key, match] of Object.entries(reconciliation.matches)) {
      const theirs = reconciliation.plc.get(key);
      if (match !== "changed" || !theirs) continue;
      bySource.set(theirs.sourceId, [...(bySource.get(theirs.sourceId) ?? []), theirs]);
    }
    // The PLC's conveyors the ghosts' zones lie on, without a body: only their zones show, not a second belt.
    const plcConfigs = new Map(this.snapshot.plcSources.map((src) => [src.sourceId, src.config]));
    for (const [sourceId, components] of bySource) {
      const ids = new Set(components.map((c) => c.id));
      const needed = new Set(components.flatMap((c) => ("zones" in c ? c.zones.map((z) => z.conveyorId) : [])));
      for (const c of plcConfigs.get(sourceId)?.components ?? []) {
        if (c.type === "conveyor" && needed.has(c.id) && !ids.has(c.id)) components.push({ ...c, body: false });
      }
    }
    const sources = [...bySource.entries()].map(([sourceId, components]) => {
      const id = ghostSourceId(sourceId);
      const config: ConfigMessage = { kind: "config", sourceId: id, protocolVersion: PROTOCOL_VERSION, configVersion: 1, components, errors: [], marks: [] };
      return { sourceId: id, config, snapshots: [], renderTime: 0, online: false };
    });
    this.ghosts = { reconciliation, sources };
    return sources;
  }

  /** The draft's sources with their configuration and the preview products; the same array per draft. */
  private draftSources(): SceneSource[] {
    const { draft } = this.snapshot;
    if (this.framed?.draft === draft) return this.framed.sources;
    const bySource = new Map<string, ConfigMessage>();
    for (const c of draft.components) {
      let config = bySource.get(c.sourceId);
      if (!config) {
        config = { kind: "config", sourceId: c.sourceId, protocolVersion: PROTOCOL_VERSION, configVersion: 1, components: [], errors: [], marks: [] };
        bySource.set(c.sourceId, config);
      }
      config.components.push(c);
    }
    const sources = [...bySource.values()].map((config) => {
      // The only states of a draft: a preview product of each type on its conveyor, and a robot with fingers at rest,
      // so its gripper shows on the flange (ADR 0018).
      const previews = config.components.flatMap((c) => {
        if (c.type === "conveyor") return c.productTypes.length > 0 ? [previewState(c)] : [];
        const rest = restState(c);
        return rest ? [rest] : [];
      });
      const snapshots: StateMessage[] =
        previews.length === 0
          ? []
          : [{ kind: "state", sourceId: config.sourceId, configVersion: 1, timestamp: "0", tRel: 0, components: previews }];
      return { sourceId: config.sourceId, config, snapshots, renderTime: 0, online: true };
    });
    this.framed = { draft, sources };
    return sources;
  }

  /** Adds a product type to a conveyor: the next free number, a 120 × 80 × 40 mm box to start from. */
  addProductType(conveyorKey: ComponentKey): void {
    const belt = this.component(conveyorKey);
    if (belt?.type !== "conveyor") return;
    const id = 1 + Math.max(0, ...belt.productTypes.map((t) => t.id));
    const type: ProductType = { id, length: 120, width: 80, height: 40, shape: "box", cornerRadius: 0 };
    this.set(conveyorKey, ["productTypes"], [...belt.productTypes, type]);
  }

  private component(key: ComponentKey) {
    return this.snapshot.draft.components.find((c) => keyOf(c) === key);
  }

  /** The conveyor a zone of a component in `sourceId` refers to by its manifest id. */
  private conveyor(sourceId: string, id: number) {
    const c = this.component(componentKey(sourceId, id));
    return c?.type === "conveyor" ? c : undefined;
  }

  private replaceAllowed(): boolean {
    return this.snapshot.saved || this.confirmDiscard();
  }

  /** Shows `draft` as saved, with no undo history. */
  private replace(draft: Draft): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.savedDraft = draft;
    this.show(draft, undefined);
    this.set_({ notice: undefined });
  }

  private edit(edit: Edit, selection = this.snapshot.selection): void {
    // Within a gesture only its first edit leaves an undo step, the draft from before the gesture.
    if (!this.gesture || this.gesture.start === this.snapshot.draft) {
      this.undoStack.push(this.snapshot.draft);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.show(applyEdit(this.snapshot.draft, edit), selection);
  }

  /** Shows `draft`; a selection whose component it does not hold (removed, undone) is dropped. */
  private show(draft: Draft, selection = this.snapshot.selection): void {
    const kept = selection !== undefined && draft.components.some((c) => keyOf(c) === selection) ? selection : undefined;
    this.set_({
      draft,
      selection: kept,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      saved: draft === this.savedDraft,
    });
  }

  private set_(changes: Partial<ConfiguratorSnapshot>): void {
    const before = this.snapshot;
    this.snapshot = { ...before, ...changes };
    // The draft or the PLCs changed: reconciled again.
    const { draft, plcSources, plcParameters } = this.snapshot;
    if (draft !== before.draft || plcSources !== before.plcSources || plcParameters !== before.plcParameters) {
      if (draft !== before.draft || plcSources !== before.plcSources) {
        this.reconciliation = reconcile(draft, plcSources);
        // Every PLC component counts, also those the draft does not have (a robot's conveyors not added with it).
        const { plc, plcOnly } = this.reconciliation;
        this.draftIssues = validateDraft(draft, new Map([...plc, ...plcOnly.map((p) => [keyOf(p), p] as const)]));
      }
      this.snapshot = {
        ...this.snapshot,
        matches: this.reconciliation.matches,
        plcOnly: this.reconciliation.plcOnly,
        issues: [
          ...this.draftIssues,
          ...hardwareHints(draft, this.reconciliation.plc),
          ...wiringHints(plcSources, plcParameters),
          ...unwritableHints(draft, this.reconciliation.plc, plcParameters),
        ],
      };
    }
    for (const l of this.listeners) l();
  }
}

/** The configurator's snapshot for a React component, re-rendered on every change. */
export function useConfigurator(configurator: Configurator): ConfiguratorSnapshot {
  return useSyncExternalStore(configurator.subscribe, configurator.getSnapshot);
}

/** Gap between the preview products on a belt, and before the first one, mm. */
const PREVIEW_GAP = 100;

/**
 * A conveyor's state in the draft: one product of each of its types, lying on the belt centre one after the other
 * from the belt start, PREVIEW_GAP apart.
 */
function previewState(belt: ConveyorConfig): ConveyorState {
  let fromStart = 0;
  const products: ConveyorState["products"] = [];
  for (const [i, t] of belt.productTypes.entries()) {
    // Only what fits: a product past the belt end would show as missed.
    if (fromStart + PREVIEW_GAP + t.length > belt.length) break;
    fromStart += PREVIEW_GAP + t.length / 2;
    const x = fromStart - belt.originShift.x;
    fromStart += t.length / 2;
    products.push({
      id: i + 1,
      // In the conveyor's coordinate system, whose origin may lie above or below the belt surface.
      latchPose: { x, y: 0 - belt.originShift.y, z: 0 - belt.originShift.z, rz: 0 },
      latchBeltPosition: 0,
      mark: 0,
      state: "detected" as const,
      previousState: "detected" as const,
      lastClientId: 0,
      moverId: 0,
      fingerId: 0,
      productType: t.id,
    });
  }
  return { type: "conveyor", id: belt.id, timestamp: "0", beltPosition: 0, products, fault: null };
}

/** Protocol version that gave every finger its offset on the flange (ADR 0018). */
const FINGER_OFFSETS_SINCE = 20;

/**
 * A draft file's content as this protocol reads it: a draft saved before finger offsets has its fingers on the flange
 * centre. Anything that is not a draft stays as it is, for the schema to refuse.
 */
function upgradeDraft(raw: unknown): unknown {
  const file = raw as { protocolVersion?: unknown; components?: unknown } | null;
  if (typeof file?.protocolVersion !== "number" || file.protocolVersion >= FINGER_OFFSETS_SINCE) return raw;
  if (!Array.isArray(file.components)) return raw;
  const onFlange = { x: 0, y: 0, z: 0, rz: 0 };
  const components = file.components.map((c: { fingers?: unknown }) =>
    Array.isArray(c?.fingers) ? { ...c, fingers: c.fingers.map((f: object) => ({ offset: onFlange, ...f })) } : c,
  );
  return { ...file, components };
}
