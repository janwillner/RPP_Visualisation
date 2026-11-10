import { useSyncExternalStore } from "react";
import { DRAFT_FILE_FORMAT_VERSION, DraftSchema, PROTOCOL_VERSION, emptyDraft, type ConfigMessage, type ConveyorConfig, type ConveyorState, type Draft, type ProductType, type StateMessage, type Zone } from "@rpp/protocol";
import { componentKey, type ComponentKey, type SceneSource } from "../scene/scene-model";
import { zoneSides } from "../machine-facts";
import { beltRange, mcsToBelt } from "./belt-coordinates";
import { defaultComponent, PALETTE_LABELS, type PaletteType } from "./component-defaults";
import { applyEdit, keyOf, type Edit } from "./edits";
import { validateDraft, type Issue } from "./validation";

/**
 * The configurator (ADR 0016): the draft of a machine being edited, the commands that edit it, undo and redo, and the
 * draft file. The 3D view reads the draft through `frame`, drawn by the same kits as the live machine.
 */

/** The source of components placed offline, until they are given the source of a PLC. */
export const DRAFT_SOURCE = "draft";

/** Positions are placed on this grid, mm. */
export const GRID_MM = 10;

/** An edge of a zone that can be dragged: along the belt its start, end and CCS, across it its two sides. */
export type ZoneEdge = "start" | "end" | "ccs" | "left" | "right";

/** Length of a new zone along its belt, mm. */
const ZONE_LENGTH = 500;

/** Extension of a saved draft file. */
export const DRAFT_FILE_EXTENSION = ".rpp-draft.json";

const snap = (v: number) => Math.round(v / GRID_MM) * GRID_MM;

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

  /** `confirmDiscard` asks whether unsaved changes may be discarded for a new or opened draft. */
  constructor(private readonly confirmDiscard: () => boolean = () => true) {
    this.savedDraft = emptyDraft();
    this.snapshot = { draft: this.savedDraft, selection: undefined, canUndo: false, canRedo: false, saved: true, issues: [], notice: undefined };
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
    if (selection === this.snapshot.selection) return;
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
      draft = DraftSchema.parse(JSON.parse(text));
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
  frame(): SceneSource[] {
    const { draft } = this.snapshot;
    if (this.framed?.draft === draft) return this.framed.sources;
    const bySource = new Map<string, ConfigMessage>();
    for (const c of draft.components) {
      let config = bySource.get(c.sourceId);
      if (!config) {
        config = { kind: "config", sourceId: c.sourceId, protocolVersion: PROTOCOL_VERSION, configVersion: 1, components: [], errors: [] };
        bySource.set(c.sourceId, config);
      }
      config.components.push(c);
    }
    const sources = [...bySource.values()].map((config) => {
      // The only state of a draft: a preview product of each type on its conveyor.
      const previews = config.components.flatMap((c) => (c.type === "conveyor" && c.productTypes.length > 0 ? [previewState(c)] : []));
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
      issues: draft === this.snapshot.draft ? this.snapshot.issues : validateDraft(draft),
    });
  }

  private set_(changes: Partial<ConfiguratorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
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
