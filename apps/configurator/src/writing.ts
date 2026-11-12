import {
  PARAMETER_FIELDS,
  type ComponentConfig,
  type Draft,
  type ParametersMessage,
  type ParameterType,
  type TypedParameters,
} from "@rpp/protocol";
import { componentKey, type ComponentKey, type SourceInfo } from "@rpp/machine-view";
import { keyOf } from "./edits";
import { sameConfig } from "./reconciliation";
import type { Issue } from "./validation";

/**
 * Writing a draft to its PLCs (ADR 0017): which parameter values would change, whether a source can be written, how a
 * write fares until the PLC handled it, and whether an application passes its parameters on to Syn_Visu.
 */

/** A component's parameter set: its parameter fields (`PARAMETER_FIELDS`); undefined for a type without one yet. */
export function parameterSetOf(c: ComponentConfig): TypedParameters | undefined {
  if (!(c.type in PARAMETER_FIELDS)) return undefined;
  const fields = PARAMETER_FIELDS[c.type as ParameterType];
  const parameters = Object.fromEntries(fields.map((f) => [f, (c as unknown as Record<string, unknown>)[f]]));
  return { type: c.type, parameters } as TypedParameters;
}

/** One value a write changes: its path below the parameter set (list entries counted from 1) and both values. */
export interface FieldChange {
  path: string;
  from: string;
  to: string;
}

export interface ComponentChange {
  key: ComponentKey;
  name: string;
  fields: FieldChange[];
}

export interface WritePlan {
  /** Why the source cannot be written now; absent when it can. */
  blocked?: string;
  /** Every component of the source whose parameter set the write changes. */
  changes: ComponentChange[];
  /**
   * The source's components whose parameter values the draft changes but its PLC has no parameter set for (no
   * parameter FB, or no Syn_Config at all): their changes cannot be written. Absent when there are none.
   */
  unwritable?: string[];
}

/** How a component's last write fares. */
export type WriteState =
  | { state: "staged"; stageId: number }
  | { state: "waiting"; stageId: number }
  | { state: "applied"; stageId: number }
  | { state: "rejected"; stageId: number; message: string }
  | { state: "failed"; message: string };

const shown = (v: unknown) => (v === undefined ? "—" : v === null ? "none" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** The leaf values that differ between two parameter values, by path; list entries counted from 1. */
export function leafChanges(from: unknown, to: unknown, path = ""): FieldChange[] {
  const join = (key: string) => (path ? `${path}.${key}` : key);
  if (Array.isArray(from) && Array.isArray(to)) {
    return Array.from({ length: Math.max(from.length, to.length) }, (_, i) => leafChanges(from[i], to[i], join(String(i + 1)))).flat();
  }
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (object(from) && object(to)) {
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])];
    return keys.flatMap((k) => leafChanges(from[k], to[k], join(k)));
  }
  return sameConfig(from, to) ? [] : [{ path, from: shown(from), to: shown(to) }];
}

/**
 * The draft's components whose parameter values differ from their PLC's (`plc`, by component key) although the PLC
 * holds no parameter set for them (`parameters` by source; none for a PLC without Syn_Config).
 */
function unwritableComponents(
  draft: Draft,
  plc: ReadonlyMap<ComponentKey, ComponentConfig>,
  parameters: Readonly<Record<string, ParametersMessage>>,
): ComponentConfig[] {
  return draft.components.filter((c) => {
    const theirs = plc.get(keyOf(c));
    const ours = parameterSetOf(c);
    if (!theirs || !ours || theirs.type !== c.type) return false;
    if (parameters[c.sourceId]?.components.some((p) => p.id === c.id && p.set.type === c.type)) return false;
    return leafChanges(parameterSetOf(theirs)?.parameters, ours.parameters).length > 0;
  });
}

/** A warning per changed component that cannot be written (`unwritableComponents`), with why. */
export function unwritableHints(
  draft: Draft,
  plc: ReadonlyMap<ComponentKey, ComponentConfig>,
  parameters: Readonly<Record<string, ParametersMessage>>,
): Issue[] {
  return unwritableComponents(draft, plc, parameters).map((c) => ({
    severity: "warning",
    key: keyOf(c),
    message: parameters[c.sourceId]
      ? `${c.name} has no parameter set on its PLC: its changes cannot be written`
      : `${c.name}: its PLC has no Syn_Config, so its changes cannot be written`,
  }));
}

/** What writing `sourceId` would change, or why it cannot be written; `plc` holds the PLCs' components by key. */
export function writePlan(
  draft: Draft,
  issues: readonly Issue[],
  parameters: Readonly<Record<string, ParametersMessage>>,
  plc: ReadonlyMap<ComponentKey, ComponentConfig>,
  sourceId: string,
): WritePlan {
  const unwritable = unwritableComponents(draft, plc, parameters)
    .filter((c) => c.sourceId === sourceId)
    .map((c) => c.name);
  const plan = planWrite(draft, issues, parameters[sourceId], sourceId);
  return unwritable.length > 0 ? { ...plan, unwritable } : plan;
}

function planWrite(draft: Draft, issues: readonly Issue[], parameters: ParametersMessage | undefined, sourceId: string): WritePlan {
  const changes: ComponentChange[] = [];
  for (const c of draft.components) {
    if (c.sourceId !== sourceId) continue;
    const theirs = parameters?.components.find((p) => p.id === c.id && p.set.type === c.type);
    const ours = parameterSetOf(c);
    if (!theirs || !ours) continue;
    const fields = leafChanges(theirs.set.parameters, ours.parameters);
    if (fields.length > 0) changes.push({ key: keyOf(c), name: c.name, fields });
  }
  if (!parameters) return { blocked: "The PLC has no Syn_Config: its components cannot be written.", changes };
  if (!parameters.writable) return { blocked: parameters.reason ?? "The PLC cannot be written.", changes };
  const keys = new Set(draft.components.filter((c) => c.sourceId === sourceId).map(keyOf));
  const errors = issues.filter((i) => i.severity === "error" && keys.has(i.key));
  if (errors.length > 0) {
    return { blocked: `Fix the errors of this PLC's components first: ${errors.map((e) => e.message).join("; ")}`, changes };
  }
  return { changes };
}

/** The write states after a new `parameters` message: a write the PLC handled is applied or rejected. */
export function followWrites(
  writes: Readonly<Record<ComponentKey, WriteState>>,
  parameters: Readonly<Record<string, ParametersMessage>>,
): Record<ComponentKey, WriteState> {
  const next: Record<ComponentKey, WriteState> = {};
  for (const [key, write] of Object.entries(writes)) {
    next[key] = write;
    if (write.state !== "staged" && write.state !== "waiting") continue;
    const sourceId = key.slice(0, key.lastIndexOf("#"));
    const id = Number(key.slice(key.lastIndexOf("#") + 1));
    const status = parameters[sourceId]?.components.find((c) => c.id === id);
    if (!status) continue;
    if (status.handledStageId === write.stageId) {
      next[key] =
        status.result === "rejected"
          ? { state: "rejected", stageId: write.stageId, message: status.message }
          : { state: "applied", stageId: write.stageId };
    } else if (status.result === "pending") {
      next[key] = { state: "waiting", stageId: write.stageId };
    }
  }
  return next;
}

/**
 * Where the visualisation shows other values than a component's active parameter set: its application does not pass
 * the effective values on to Syn_Visu (ADR 0017).
 */
export function wiringHints(sources: readonly SourceInfo[], parameters: Readonly<Record<string, ParametersMessage>>): Issue[] {
  const hints: Issue[] = [];
  for (const source of sources) {
    const message = parameters[source.sourceId];
    if (!message || !source.config) continue;
    for (const p of message.components) {
      const shownConfig = source.config.components.find((c) => c.id === p.id && c.type === p.set.type);
      const shownSet = shownConfig && parameterSetOf(shownConfig);
      if (!shownSet) continue;
      const fields = Object.keys(p.set.parameters).filter(
        (f) => !sameConfig((shownSet.parameters as Record<string, unknown>)[f], (p.set.parameters as Record<string, unknown>)[f]),
      );
      if (fields.length === 0) continue;
      hints.push({
        severity: "warning",
        key: componentKey(source.sourceId, p.id),
        message:
          `${shownConfig.name}: the visualisation shows other values than the active parameter set ` +
          `(${fields.join(", ")}); does the application pass them on to Syn_Visu?`,
      });
    }
  }
  return hints;
}
