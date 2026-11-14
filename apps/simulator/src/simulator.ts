import { useSyncExternalStore } from "react";
import {
  RECIPE_FILE_FORMAT,
  RECIPE_FILE_FORMAT_VERSION,
  RecipeFileSchema,
  invalidRecipeValue,
  type Machine,
  type MachineCommandKind,
  type MessageSeverity,
  type Recipe,
  type RecipeField,
  type RecipeFile,
  type RecipeValue,
  type RunState,
  recipeProgramValue,
  writeBlockedReason,
} from "@rpp/protocol";
import {
  activeMachineMessages,
  componentName,
  dcTimeOfDay,
  fieldLabel,
  isOnline,
  machineMessagePlace,
  machineMessageText,
  writeKey,
  type GatewayLive,
  type Selection,
  type SourcedFaults,
  type SourceInfo,
  type TrackedWrite,
} from "@rpp/machine-view";

/**
 * The Simulator (ADR 0020, 0022): the machine's recipe edited in a form, written to the PLC and followed until the
 * application took it over, saved to and opened from a file; the machine commands Start, Stop and Reset with the
 * application's answer; the machine messages and component faults. The sequence control stays in the PLC: the
 * Simulator only asks, and only while the machine reports simulation mode.
 */

export const RECIPE_FILE_EXTENSION = ".rpp-sim.json";


/** One field of the recipe form. */
export interface RecipeFormField {
  field: RecipeField;
  /** The application's label, else the field's name put into words. */
  label: string;
  /**
   * The field applies: it has no visibility condition, or its condition's field is visible and has the condition's
   * value in the form (#49). A hidden field keeps its edit, which is written; the page leaves it out.
   */
  visible: boolean;
  /** The value the application runs with; undefined until the PLC reports it. */
  active: RecipeValue | undefined;
  /** What the form shows: the edited value, else the active one. */
  value: RecipeValue;
  /** The edited value differs from the active one: a write would change it. */
  changed: boolean;
  /** Why the shown value cannot be written. */
  error?: string;
  /** Something to know about the value, e.g. that the opened file saved it for another component. */
  warning?: string;
}

/** The fields of one component, or of the whole machine (group 0), in the order the application declares them. */
export interface RecipeFormGroup {
  group: number;
  name: string;
  /** The group of the selected component. */
  selected: boolean;
  /** One of its fields is visible; the page leaves a group out while none is. */
  visible: boolean;
  fields: RecipeFormField[];
}

export interface Problem {
  severity: "error" | "warning";
  text: string;
  /** The recipe field it is about. */
  field?: string;
  /** The component whose field it is about; none for a field of the whole machine. */
  selection?: Selection;
}

/** One value a write changes, as the form shows it. */
export interface RecipeChange {
  name: string;
  label: string;
  from: string;
  to: string;
  /** The field does not apply in the form now (its condition does not hold); it is written all the same. */
  hidden: boolean;
}

export interface WritePlan {
  /** Why nothing can be written now; absent when the changes can. */
  blocked?: string;
  changes: RecipeChange[];
}

/** How the last recipe write or reset to program values of a source fares. */
export type RecipeWrite = { kind: "write" | "reset" } & (
  | { state: "staged" | "waiting" | "applied"; stageId: number }
  | { state: "rejected"; stageId: number; message: string }
  | { state: "failed"; message: string }
);

/** Whether a machine command can be sent now, and why not. */
export interface CommandAvailability {
  enabled: boolean;
  reason?: string;
}

/** The last machine command of a source and the application's answer. */
export type CommandState = { command: MachineCommandKind } & (
  | { state: "sent" | "accepted"; commandId: number }
  | { state: "rejected"; commandId: number; message: string }
  | { state: "failed"; message: string }
);

/** A machine message or a component fault, for the list in the status bar. */
export interface MessageEntry {
  text: string;
  severity: MessageSeverity;
  /** The component it is about. */
  selection?: Selection;
}

export interface SimulatorSnapshot {
  sources: readonly SourceInfo[];
  /** The source whose recipe and commands are shown. */
  sourceId: string | undefined;
  machine: Machine | undefined;
  recipe: Recipe | undefined;
  form: RecipeFormGroup[];
  problems: Problem[];
  /** Name of the recipe; it names the saved file. */
  name: string;
  /** No edit would be lost: every edited value is in the last saved or opened file. */
  saved: boolean;
  write: RecipeWrite | undefined;
  /** Why the shown source can be neither written nor commanded now: offline, no machine FB, no write access, no
   * simulation mode; undefined when it can. */
  blocked: string | undefined;
  commands: Record<MachineCommandKind, CommandAvailability>;
  command: CommandState | undefined;
  /** The shown source's active machine messages with their id and time, then its component faults. */
  messages: MessageEntry[];
  selection: Selection;
  notice: string | undefined;
}

export interface RecipeFileText {
  text: string;
  name: string;
}

type Values = Record<string, RecipeValue>;

/** The machine commands, in the order the page shows them. */
export const COMMANDS: readonly MachineCommandKind[] = ["start", "stop", "reset"];

/** The run states in which a command makes sense; the application decides all the same. */
const COMMAND_RUN_STATES: Record<MachineCommandKind, { states: readonly RunState[]; reason: string }> = {
  start: { states: ["stopped"], reason: "The machine is not stopped." },
  stop: { states: ["starting", "running"], reason: "The machine is not running." },
  reset: { states: ["stopped", "fault"], reason: "Stop the machine first." },
};

/**
 * The fields that apply with these values (#49): a field without a visibility condition, or one whose condition's
 * field applies and has the condition's value (a switch as 0 / 1). A condition the gateway let through that cannot be
 * followed (an unknown field, a ring) does not hide its field.
 */
function visibleFields(fields: readonly RecipeField[], valueOf: (field: RecipeField) => RecipeValue): Set<string> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const applies = (field: RecipeField, depth: number): boolean => {
    const condition = field.visibleWhen;
    const on = condition ? byName.get(condition.field) : undefined;
    if (!condition || !on || depth > fields.length) return true;
    return Number(valueOf(on)) === condition.value && applies(on, depth + 1);
  };
  return new Set(fields.filter((f) => applies(f, 0)).map((f) => f.name));
}

/** A recipe write or reset as the page shows it. */
function recipeWrite(write: TrackedWrite | undefined): RecipeWrite | undefined {
  if (!write) return undefined;
  const { kind, ...state } = write;
  return { kind: kind === "resetRecipe" ? "reset" : "write", ...state };
}

/** A machine command as the page shows it: sent until the application answered, then accepted or rejected. */
function commandState(write: TrackedWrite | undefined, command: MachineCommandKind | undefined): CommandState | undefined {
  if (!write || !command) return undefined;
  switch (write.state) {
    case "staged":
    case "waiting":
      return { command, state: "sent", commandId: write.stageId };
    case "applied":
      return { command, state: "accepted", commandId: write.stageId };
    case "rejected":
      return { command, state: "rejected", commandId: write.stageId, message: write.message };
    case "failed":
      return { command, state: "failed", message: write.message };
  }
}

/** A field's value as the form shows it: on / off, a choice's name, a number with its unit. */
export function shownValue(field: RecipeField, value: RecipeValue | undefined): string {
  if (value === undefined) return "—";
  if (field.type === "switch") return value ? "on" : "off";
  if (field.type === "choice" && typeof value === "number") return field.choices[value] ?? String(value);
  return field.unit ? `${value} ${field.unit}` : String(value);
}


export class Simulator {
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private chosenSource: string | undefined;
  private edits: Record<string, Values> = {};
  /** Per source, the values of the last saved or opened file. */
  private savedValues: Record<string, Values> = {};
  /** Per source and field, what the opened file says about it. */
  private fieldWarnings: Record<string, Record<string, string>> = {};
  private fileWarnings: string[] = [];
  /** The values the last recipe write of a source sent, with its stage id: dropped from the edits once applied. */
  private writtenValues: Record<string, { stageId: number; values: Values }> = {};
  /** The last machine command sent to each source. */
  private lastCommand: Record<string, MachineCommandKind> = {};
  private faults: readonly SourcedFaults[] = [];
  private selection: Selection = undefined;
  private name = "Recipe";
  private notice: string | undefined;
  private snapshot: SimulatorSnapshot;

  constructor(
    private readonly live: GatewayLive,
    /** Asks whether edits that were not saved may be discarded. */
    private readonly confirmDiscard: () => boolean,
  ) {
    this.snapshot = this.build();
  }

  start(): void {
    this.unsubscribe ??= this.live.subscribe(() => {
      this.followAnswers();
      this.changed();
    });
    this.followAnswers();
    this.changed();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  // The source and the selection.

  selectSource(sourceId: string): void {
    this.chosenSource = sourceId;
    this.changed();
  }

  select(selection: Selection): void {
    this.selection = selection;
    this.changed();
  }

  /** The component faults the 3D view found (`SceneView`'s `onFaults`). */
  setFaults(faults: readonly SourcedFaults[]): void {
    this.faults = faults;
    this.changed();
  }

  // The recipe form.

  /** The field of the shown recipe with this name. */
  field(name: string): RecipeFormField | undefined {
    return this.snapshot.form.flatMap((g) => g.fields).find((f) => f.field.name === name);
  }

  /** Edits a field of the shown recipe; an edit back to the active value is none. */
  edit(name: string, value: RecipeValue): void {
    const sourceId = this.snapshot.sourceId;
    const recipe = this.snapshot.recipe;
    if (!sourceId || !recipe?.fields.some((f) => f.name === name)) return;
    const { [name]: _old, ...rest } = this.edits[sourceId] ?? {};
    this.edits = { ...this.edits, [sourceId]: recipe.values[name] === value ? rest : { ...rest, [name]: value } };
    this.changed();
  }

  /** Returns the shown recipe's form to the active values, after asking when edits were not saved. */
  discardEdits(): void {
    const sourceId = this.snapshot.sourceId;
    if (!sourceId || !this.edits[sourceId] || (!this.snapshot.saved && !this.confirmDiscard())) return;
    const { [sourceId]: _edits, ...edits } = this.edits;
    const { [sourceId]: _warnings, ...warnings } = this.fieldWarnings;
    this.edits = edits;
    this.fieldWarnings = warnings;
    this.changed();
  }

  rename(name: string): void {
    this.name = name.trim() || "Recipe";
    this.changed();
  }

  dismissNotice(): void {
    this.notice = undefined;
    this.changed();
  }

  // Writing the recipe (ADR 0022).

  /** What writing the shown recipe would change, or why it cannot be written. */
  writePlan(): WritePlan {
    const changes = this.snapshot.form.flatMap((g) =>
      g.fields
        .filter((f) => f.changed)
        .map((f) => ({
          name: f.field.name,
          label: f.label,
          from: shownValue(f.field, f.active),
          to: shownValue(f.field, f.value),
          hidden: !f.visible,
        })),
    );
    const blocked = this.snapshot.blocked;
    if (blocked) return { blocked, changes };
    const errors = this.snapshot.problems.filter((p) => p.severity === "error");
    if (errors.length > 0) return { blocked: `Fix the errors of the recipe first: ${errors.map((e) => e.text).join("; ")}`, changes };
    return { changes };
  }

  /** Stages the changed values of the shown recipe on its active version; the PLC's answer follows. */
  async write(): Promise<void> {
    const { sourceId, recipe } = this.snapshot;
    const plan = this.writePlan();
    if (!sourceId || !recipe || plan.blocked || plan.changes.length === 0) return;
    const values = Object.fromEntries(plan.changes.map((c) => [c.name, this.edits[sourceId]![c.name]!]));
    const write = await this.live.stage({ kind: "writeRecipe", sourceId, baseVersion: recipe.activeVersion, values });
    if ("stageId" in write) this.writtenValues = { ...this.writtenValues, [sourceId]: { stageId: write.stageId, values } };
    this.followAnswers();
    this.changed();
  }

  /** Makes the active recipe invalid, so the application runs with its program values again. */
  async resetRecipe(): Promise<void> {
    const { sourceId, recipe } = this.snapshot;
    if (!sourceId || !recipe || this.snapshot.blocked) return;
    const { [sourceId]: _written, ...written } = this.writtenValues;
    this.writtenValues = written;
    await this.live.stage({ kind: "resetRecipe", sourceId, baseVersion: recipe.activeVersion });
    this.changed();
  }

  // Machine commands.

  /** Asks the shown machine to start, stop or reset; the application answers. */
  async command(command: MachineCommandKind): Promise<void> {
    const sourceId = this.snapshot.sourceId;
    if (!sourceId || !this.snapshot.commands[command].enabled) return;
    this.lastCommand = { ...this.lastCommand, [sourceId]: command };
    await this.live.stage({ kind: "machineCommand", sourceId, command });
    this.changed();
  }

  // The recipe file.

  /** Every source's recipe as a file, by group and field name; what it holds counts as saved. */
  save(): RecipeFileText {
    const { sources: all, parameters } = this.live.getSnapshot();
    const sources = all.filter((s) => parameters[s.sourceId]?.recipe);
    const file: RecipeFile = {
      format: RECIPE_FILE_FORMAT,
      formatVersion: RECIPE_FILE_FORMAT_VERSION,
      name: this.name,
      sources: sources.map((s) => {
        const recipe = parameters[s.sourceId]!.recipe!;
        const values: Record<string, Values> = {};
        for (const f of recipe.fields) (values[String(f.group)] ??= {})[f.name] = this.shown(s.sourceId, recipe, f);
        return { sourceId: s.sourceId, sourceName: s.name, values };
      }),
    };
    this.savedValues = Object.fromEntries(
      file.sources.map((s) => [s.sourceId, Object.assign({}, ...Object.values(s.values)) as Values]),
    );
    this.changed();
    return { text: JSON.stringify(file, null, 2), name: `${this.name}${RECIPE_FILE_EXTENSION}` };
  }

  /**
   * Opens a recipe file, after asking when edits were not saved: per source its values that differ from the active
   * ones become edits, a field the file leaves out keeps its active value, a field the recipe does not have is skipped
   * with a warning.
   */
  open(text: string): void {
    let file: RecipeFile;
    try {
      file = RecipeFileSchema.parse(JSON.parse(text));
    } catch {
      this.notice = "The file is not a recipe file of the Simulator, or it is damaged.";
      this.changed();
      return;
    }
    if (file.formatVersion !== RECIPE_FILE_FORMAT_VERSION) {
      this.notice =
        `The recipe file has layout version ${file.formatVersion}; this Simulator reads version ${RECIPE_FILE_FORMAT_VERSION}` +
        (file.formatVersion > RECIPE_FILE_FORMAT_VERSION ? ": update it to open the file." : ".");
      this.changed();
      return;
    }
    if (!this.snapshot.saved && !this.confirmDiscard()) return;

    const { sources, parameters } = this.live.getSnapshot();
    const withRecipe = sources.filter((s) => parameters[s.sourceId]?.recipe);
    this.edits = {};
    this.fieldWarnings = {};
    this.fileWarnings = [];
    this.savedValues = {};
    for (const saved of file.sources) {
      // The same PLC, or the only one with a recipe when the file has only one (a recipe taken to another machine).
      const source =
        withRecipe.find((s) => s.sourceId === saved.sourceId) ??
        (file.sources.length === 1 && withRecipe.length === 1 ? withRecipe[0] : undefined);
      if (!source) {
        this.fileWarnings.push(`The file's recipe of ${saved.sourceName} has no PLC here: skipped.`);
        continue;
      }
      this.applyFileValues(source, parameters[source.sourceId]!.recipe!, saved.values);
    }
    this.name = file.name;
    this.changed();
  }

  // Inside.

  /** One source's values of a file: matched to the recipe's fields by name. */
  private applyFileValues(source: SourceInfo, recipe: Recipe, values: Record<string, Values>): void {
    const edits: Values = {};
    const warnings: Record<string, string> = {};
    const groupName = (group: number) => (group === 0 ? "the whole machine" : componentName(source.config, group));
    for (const f of recipe.fields) {
      const own = values[String(f.group)]?.[f.name];
      const others = Object.keys(values).filter((g) => g !== String(f.group) && values[g]![f.name] !== undefined);
      const value = own ?? (others.length > 0 ? values[others[0]!]![f.name] : undefined);
      if (others.length > 0) {
        warnings[f.name] =
          `The file saved it for ${others.map((g) => groupName(Number(g))).join(", ")}; it belongs to ${groupName(f.group)}` +
          (own === undefined ? "." : ", whose value is taken.");
      }
      if (value !== undefined && value !== recipe.values[f.name]) edits[f.name] = value;
    }
    for (const [group, fields] of Object.entries(values)) {
      for (const name of Object.keys(fields)) {
        if (!recipe.fields.some((f) => f.name === name)) {
          this.fileWarnings.push(`${name} (${groupName(Number(group))}) is not a field of the recipe of ${source.name}: skipped.`);
        }
      }
    }
    this.edits[source.sourceId] = edits;
    this.fieldWarnings[source.sourceId] = warnings;
    this.savedValues[source.sourceId] = Object.fromEntries(recipe.fields.map((f) => [f.name, this.shown(source.sourceId, recipe, f)]));
  }

  private shown(sourceId: string, recipe: Recipe, f: RecipeField): RecipeValue {
    return this.edits[sourceId]?.[f.name] ?? recipe.values[f.name] ?? recipeProgramValue(f);
  }

  /** Why the shown source can be neither written nor commanded now; undefined when it can. */
  private blocked(sourceId: string | undefined): string | undefined {
    const { sources, parameters } = this.live.getSnapshot();
    const source = sources.find((s) => s.sourceId === sourceId);
    if (!source) return "The gateway reads no PLC.";
    // Recipes and machine commands are blocked for the same reasons.
    return writeBlockedReason("recipe", {
      online: isOnline(source),
      parameters: parameters[source.sourceId],
      simulation: source.machine?.simulation === true,
    });
  }

  /**
   * The edits a recipe write sent stop being edits once the PLC applied the write (they are the active values now); a
   * write rejected or failed keeps them. `GatewayLive` follows the write.
   */
  private followAnswers(): void {
    const writes = this.live.getSnapshot().writes;
    for (const [sourceId, { stageId, values }] of Object.entries(this.writtenValues)) {
      const write = writes[writeKey({ kind: "writeRecipe", sourceId })];
      if (write?.state === "staged" || write?.state === "waiting") continue;
      const { [sourceId]: _handled, ...rest } = this.writtenValues;
      this.writtenValues = rest;
      if (write?.state !== "applied" || write.stageId !== stageId) continue;
      const edits = Object.entries(this.edits[sourceId] ?? {}).filter(([name, value]) => values[name] !== value);
      this.edits = { ...this.edits, [sourceId]: Object.fromEntries(edits) };
    }
  }

  private changed(): void {
    this.snapshot = this.build();
    for (const l of this.listeners) l();
  }

  private build(): SimulatorSnapshot {
    const { sources, parameters, writes } = this.live.getSnapshot();
    const sourceId =
      sources.find((s) => s.sourceId === this.chosenSource)?.sourceId ??
      sources.find((s) => parameters[s.sourceId]?.recipe)?.sourceId ??
      sources[0]?.sourceId;
    const source = sources.find((s) => s.sourceId === sourceId);
    const recipe = sourceId ? parameters[sourceId]?.recipe : undefined;
    const form = source && recipe ? this.form(source, recipe) : [];
    const problems: Problem[] = [
      ...form.flatMap((g) => {
        const about = g.group !== 0 && sourceId ? { selection: { kind: "component" as const, sourceId, id: g.group } } : {};
        return g.fields.flatMap((f): Problem[] => [
          ...(f.error ? [{ ...about, severity: "error" as const, text: f.error, field: f.field.name }] : []),
          ...(f.warning ? [{ ...about, severity: "warning" as const, text: `${f.label}: ${f.warning}`, field: f.field.name }] : []),
        ]);
      }),
      ...this.fileWarnings.map((text) => ({ severity: "warning" as const, text })),
    ];
    const saved = Object.entries(this.edits).every(([s, edits]) =>
      Object.entries(edits).every(([name, value]) => this.savedValues[s]?.[name] === value),
    );
    const blocked = this.blocked(sourceId);
    const commands = Object.fromEntries(
      COMMANDS.map((c): [MachineCommandKind, CommandAvailability] => {
        if (blocked) return [c, { enabled: false, reason: blocked }];
        const { states, reason } = COMMAND_RUN_STATES[c];
        return [c, states.includes(source!.machine!.runState) ? { enabled: true } : { enabled: false, reason }];
      }),
    ) as Record<MachineCommandKind, CommandAvailability>;
    return {
      sources,
      sourceId,
      machine: source?.machine,
      recipe,
      form,
      problems,
      name: this.name,
      saved,
      write: sourceId ? recipeWrite(writes[writeKey({ kind: "writeRecipe", sourceId })]) : undefined,
      blocked,
      commands,
      command: sourceId ? commandState(writes[writeKey({ kind: "machineCommand", sourceId })], this.lastCommand[sourceId]) : undefined,
      messages: source ? this.messages(source) : [],
      selection: this.selection,
      notice: this.notice,
    };
  }

  private form(source: SourceInfo, recipe: Recipe): RecipeFormGroup[] {
    const groups: RecipeFormGroup[] = [];
    const edits = this.edits[source.sourceId] ?? {};
    const warnings = this.fieldWarnings[source.sourceId] ?? {};
    const valueOf = (field: RecipeField) => edits[field.name] ?? recipe.values[field.name] ?? recipeProgramValue(field);
    const visible = visibleFields(recipe.fields, valueOf);
    for (const field of recipe.fields) {
      let group = groups.find((g) => g.group === field.group);
      if (!group) {
        const name = field.group === 0 ? "Machine" : componentName(source.config, field.group);
        const selection = this.selection;
        const selected =
          field.group !== 0 && selection?.kind === "component" && selection.sourceId === source.sourceId && selection.id === field.group;
        group = { group: field.group, name, selected, visible: false, fields: [] };
        groups.push(group);
      }
      const active = recipe.values[field.name];
      const value = valueOf(field);
      const error = invalidRecipeValue(field, value);
      const warning = warnings[field.name];
      group.fields.push({
        field,
        label: field.label || fieldLabel(field.name),
        visible: visible.has(field.name),
        active,
        value,
        changed: edits[field.name] !== undefined && edits[field.name] !== active,
        ...(error ? { error } : {}),
        ...(warning ? { warning } : {}),
      });
    }
    for (const group of groups) group.visible = group.fields.some((f) => f.visible);
    // The machine's own fields after its components'.
    return [...groups.filter((g) => g.group !== 0), ...groups.filter((g) => g.group === 0)];
  }

  /** The shown source's active machine messages, with their id and time, then its component faults. */
  private messages(source: SourceInfo): MessageEntry[] {
    const component = (id: number): Selection => ({ kind: "component", sourceId: source.sourceId, id });
    const messages = activeMachineMessages(source.machine).map(
      (m): MessageEntry => ({
        text: `${machineMessagePlace(m, source.config, source.name)}: ${machineMessageText(m)} · #${m.id} · ${dcTimeOfDay(m.time)}`,
        severity: m.severity,
        ...(m.componentId !== 0 ? { selection: component(m.componentId) } : {}),
      }),
    );
    const faults = this.faults
      .filter((f) => f.sourceId === source.sourceId)
      .flatMap((f) => {
        const selection = component(f.componentId);
        return [
          ...f.messages.map(
            (text): MessageEntry => ({ text: `${componentName(source.config, f.componentId)}: ${text}`, severity: "error", selection }),
          ),
          ...f.limitViolations.map((text): MessageEntry => ({ text, severity: "warning", selection })),
        ];
      });
    return [...messages, ...faults];
  }
}

/** The Simulator's snapshot, re-rendering on every change. */
export function useSimulator(simulator: Simulator): SimulatorSnapshot {
  return useSyncExternalStore(simulator.subscribe, simulator.getSnapshot);
}
