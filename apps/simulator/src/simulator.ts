import { useSyncExternalStore } from "react";
import {
  RECIPE_FILE_FORMAT,
  RECIPE_FILE_FORMAT_VERSION,
  RecipeFileSchema,
  invalidRecipeValue,
  type ClientMessage,
  type Machine,
  type MachineCommandKind,
  type MessageSeverity,
  type ParametersMessage,
  type Recipe,
  type RecipeField,
  type RecipeFile,
  type RecipeValue,
  type WriteResultMessage,
} from "@rpp/protocol";
import {
  activeMachineMessages,
  componentName,
  fieldLabel,
  isOnline,
  machineMessagePlace,
  machineMessageText,
  type LiveSnapshot,
  type Selection,
  type SourcedFaults,
  type SourceInfo,
} from "@rpp/machine-view";

/**
 * The Simulator (ADR 0020, 0022): the machine's recipe edited in a form, written to the PLC and followed until the
 * application took it over, saved to and opened from a file; the machine commands Start, Stop and Reset with the
 * application's answer; the machine messages and component faults. The sequence control stays in the PLC: the
 * Simulator only asks, and only while the machine reports simulation mode.
 */

export const RECIPE_FILE_EXTENSION = ".rpp-sim.json";

/** The gateway as the Simulator reads it: `GatewayLive` of `@rpp/machine-view`, a fake in tests. */
export interface SimulatorLive {
  getSnapshot(): LiveSnapshot;
  subscribe(listener: () => void): () => void;
  /** Sends a command to the gateway and gives its answer. */
  command(command: ClientMessage): Promise<WriteResultMessage>;
}

/** One field of the recipe form. */
export interface RecipeFormField {
  field: RecipeField;
  label: string;
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
  fields: RecipeFormField[];
}

export interface Problem {
  severity: "error" | "warning";
  text: string;
  /** The recipe field it is about. */
  field?: string;
}

/** One value a write changes, as the form shows it. */
export interface RecipeChange {
  name: string;
  label: string;
  from: string;
  to: string;
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
  /** Every source's active machine messages, then the component faults. */
  messages: MessageEntry[];
  selection: Selection;
  notice: string | undefined;
}

export interface RecipeFileText {
  text: string;
  name: string;
}

type Values = Record<string, RecipeValue>;

const COMMANDS: readonly MachineCommandKind[] = ["start", "stop", "reset"];

/** The run states in which a command makes sense; the application decides all the same. */
const COMMAND_RUN_STATES: Record<MachineCommandKind, { states: readonly string[]; reason: string }> = {
  start: { states: ["stopped"], reason: "The machine is not stopped." },
  stop: { states: ["starting", "running"], reason: "The machine is not running." },
  reset: { states: ["stopped", "fault"], reason: "Stop the machine first." },
};

/** A field's value as the form shows it: on / off, a choice's name, a number with its unit. */
export function shownValue(field: RecipeField, value: RecipeValue | undefined): string {
  if (value === undefined) return "—";
  if (field.type === "switch") return value ? "on" : "off";
  if (field.type === "choice" && typeof value === "number") return field.choices[value] ?? String(value);
  return field.unit ? `${value} ${field.unit}` : String(value);
}

const programValue = (f: RecipeField): RecipeValue => (f.type === "switch" ? f.programValue !== 0 : f.programValue);

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
  private writes: Record<string, RecipeWrite> = {};
  /** The values a write sent, by source: dropped from the edits once the PLC applied them. */
  private sent: Record<string, Values> = {};
  private commandStates: Record<string, CommandState> = {};
  private faults: readonly SourcedFaults[] = [];
  private selection: Selection = undefined;
  private name = "Recipe";
  private notice: string | undefined;
  private nextRequest = 1;
  private snapshot: SimulatorSnapshot;

  constructor(
    private readonly live: SimulatorLive,
    /** Asks whether edits that were not saved may be discarded. */
    private readonly confirmDiscard: () => boolean,
  ) {
    this.snapshot = this.build();
  }

  start(): void {
    this.unsubscribe ??= this.live.subscribe(() => {
      this.follow();
      this.changed();
    });
    this.follow();
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
        .map((f) => ({ name: f.field.name, label: f.label, from: shownValue(f.field, f.active), to: shownValue(f.field, f.value) })),
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
    const answer = await this.send({ kind: "writeRecipe", requestId: 0, sourceId, baseVersion: recipe.activeVersion, values });
    this.sent = { ...this.sent, [sourceId]: values };
    this.track(sourceId, "write", answer);
  }

  /** Makes the active recipe invalid, so the application runs with its program values again. */
  async resetRecipe(): Promise<void> {
    const { sourceId, recipe } = this.snapshot;
    if (!sourceId || !recipe || this.snapshot.blocked) return;
    const answer = await this.send({ kind: "resetRecipe", requestId: 0, sourceId, baseVersion: recipe.activeVersion });
    this.sent = { ...this.sent, [sourceId]: {} };
    this.track(sourceId, "reset", answer);
  }

  // Machine commands.

  /** Asks the shown machine to start, stop or reset; the application answers. */
  async command(command: MachineCommandKind): Promise<void> {
    const sourceId = this.snapshot.sourceId;
    if (!sourceId || !this.snapshot.commands[command].enabled) return;
    const answer = await this.send({ kind: "machineCommand", requestId: 0, sourceId, command });
    this.commandStates = {
      ...this.commandStates,
      [sourceId]:
        answer.ok && answer.stageId !== undefined
          ? { command, state: "sent", commandId: answer.stageId }
          : { command, state: "failed", message: answer.error ?? "The gateway refused the command." },
    };
    this.follow();
    this.changed();
  }

  // The recipe file.

  /** Every source's recipe as a file, by group and field name; what it holds counts as saved. */
  save(): RecipeFileText {
    const parameters = this.live.getSnapshot().parameters;
    const sources = this.live.getSnapshot().sources.filter((s) => parameters[s.sourceId]?.recipe);
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
    if (file.formatVersion > RECIPE_FILE_FORMAT_VERSION) {
      this.notice = "The recipe file was saved by a newer Simulator; update this one to open it.";
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
      this.take(source, parameters[source.sourceId]!.recipe!, saved.values);
    }
    this.name = file.name;
    this.changed();
  }

  // Inside.

  /** One source's values of a file: matched to the recipe's fields by name. */
  private take(source: SourceInfo, recipe: Recipe, values: Record<string, Values>): void {
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
    return this.edits[sourceId]?.[f.name] ?? recipe.values[f.name] ?? programValue(f);
  }

  /** Why the shown source can be neither written nor commanded now; undefined when it can. */
  private blocked(sourceId: string | undefined): string | undefined {
    const { sources, parameters } = this.live.getSnapshot();
    const source = sources.find((s) => s.sourceId === sourceId);
    if (!source) return "The gateway reads no PLC.";
    if (!isOnline(source)) return "The PLC is not connected.";
    const p: ParametersMessage | undefined = parameters[source.sourceId];
    if (!p?.recipe) return "The PLC has no machine FB (Syn_Config 2.1 or later): it has no recipe and takes no commands.";
    if (!p.writable) return p.reason ?? "The PLC cannot be written.";
    if (!source.machine?.simulation) return "The machine does not report simulation mode: the Simulator writes nothing to a real machine.";
    return undefined;
  }

  private async send(command: ClientMessage): Promise<WriteResultMessage> {
    return this.live.command({ ...command, requestId: this.nextRequest++ });
  }

  private track(sourceId: string, kind: "write" | "reset", answer: WriteResultMessage): void {
    this.writes = {
      ...this.writes,
      [sourceId]:
        answer.ok && answer.stageId !== undefined
          ? { kind, state: "staged", stageId: answer.stageId }
          : { kind, state: "failed", message: answer.error ?? "The gateway refused the write." },
    };
    this.follow();
    this.changed();
  }

  /** Writes and commands the PLC has answered since. */
  private follow(): void {
    const parameters = this.live.getSnapshot().parameters;
    for (const [sourceId, write] of Object.entries(this.writes)) {
      const recipe = parameters[sourceId]?.recipe;
      if (!recipe || (write.state !== "staged" && write.state !== "waiting")) continue;
      if (recipe.handledStageId === write.stageId) {
        this.writes = {
          ...this.writes,
          [sourceId]:
            recipe.result === "rejected"
              ? { kind: write.kind, state: "rejected", stageId: write.stageId, message: recipe.message }
              : { kind: write.kind, state: "applied", stageId: write.stageId },
        };
        if (recipe.result !== "rejected") this.dropWritten(sourceId);
      } else if (recipe.result === "pending" && write.state === "staged") {
        this.writes = { ...this.writes, [sourceId]: { ...write, state: "waiting" } };
      }
    }
    for (const [sourceId, state] of Object.entries(this.commandStates)) {
      const answer = parameters[sourceId]?.machineCommand;
      if (state.state !== "sent" || answer?.handledCommandId !== state.commandId) continue;
      this.commandStates = {
        ...this.commandStates,
        [sourceId]:
          answer.result === "rejected"
            ? { command: state.command, state: "rejected", commandId: state.commandId, message: answer.message }
            : { command: state.command, state: "accepted", commandId: state.commandId },
      };
    }
  }

  /** The edits a write sent, once the PLC applied them: they are the active values now. */
  private dropWritten(sourceId: string): void {
    const sent = this.sent[sourceId] ?? {};
    const edits = Object.entries(this.edits[sourceId] ?? {}).filter(([name, value]) => sent[name] !== value);
    this.edits = { ...this.edits, [sourceId]: Object.fromEntries(edits) };
  }

  private changed(): void {
    this.snapshot = this.build();
    for (const l of this.listeners) l();
  }

  private build(): SimulatorSnapshot {
    const { sources, parameters } = this.live.getSnapshot();
    const sourceId =
      sources.find((s) => s.sourceId === this.chosenSource)?.sourceId ??
      sources.find((s) => parameters[s.sourceId]?.recipe)?.sourceId ??
      sources[0]?.sourceId;
    const source = sources.find((s) => s.sourceId === sourceId);
    const recipe = sourceId ? parameters[sourceId]?.recipe : undefined;
    const form = source && recipe ? this.form(source, recipe) : [];
    const problems: Problem[] = [
      ...form.flatMap((g) =>
        g.fields.flatMap((f): Problem[] => [
          ...(f.error ? [{ severity: "error" as const, text: f.error, field: f.field.name }] : []),
          ...(f.warning ? [{ severity: "warning" as const, text: `${f.label}: ${f.warning}`, field: f.field.name }] : []),
        ]),
      ),
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
      write: sourceId ? this.writes[sourceId] : undefined,
      blocked,
      commands,
      command: sourceId ? this.commandStates[sourceId] : undefined,
      messages: this.messages(sources),
      selection: this.selection,
      notice: this.notice,
    };
  }

  private form(source: SourceInfo, recipe: Recipe): RecipeFormGroup[] {
    const groups: RecipeFormGroup[] = [];
    const edits = this.edits[source.sourceId] ?? {};
    const warnings = this.fieldWarnings[source.sourceId] ?? {};
    for (const field of recipe.fields) {
      let group = groups.find((g) => g.group === field.group);
      if (!group) {
        group = { group: field.group, name: field.group === 0 ? "Machine" : componentName(source.config, field.group), fields: [] };
        groups.push(group);
      }
      const active = recipe.values[field.name];
      const value = edits[field.name] ?? active ?? programValue(field);
      const error = invalidRecipeValue(field, value);
      const warning = warnings[field.name];
      group.fields.push({
        field,
        label: fieldLabel(field.name),
        active,
        value,
        changed: edits[field.name] !== undefined && edits[field.name] !== active,
        ...(error ? { error } : {}),
        ...(warning ? { warning } : {}),
      });
    }
    // The machine's own fields after its components'.
    return [...groups.filter((g) => g.group !== 0), ...groups.filter((g) => g.group === 0)];
  }

  private messages(sources: readonly SourceInfo[]): MessageEntry[] {
    const component = (sourceId: string, id: number): Selection => ({ kind: "component", sourceId, id });
    const messages = sources.flatMap((s) =>
      activeMachineMessages(s.machine).map(
        (m): MessageEntry => ({
          text: `${machineMessagePlace(m, s.config, s.name)}: ${machineMessageText(m)}`,
          severity: m.severity,
          ...(m.componentId !== 0 ? { selection: component(s.sourceId, m.componentId) } : {}),
        }),
      ),
    );
    const faults = this.faults.flatMap((f) => {
      const config = sources.find((s) => s.sourceId === f.sourceId)?.config;
      const selection = component(f.sourceId, f.componentId);
      return [
        ...f.messages.map((text): MessageEntry => ({ text: `${componentName(config, f.componentId)}: ${text}`, severity: "error", selection })),
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
