import { HARDWARE_FIELDS, type ComponentConfig, type Draft } from "@rpp/protocol";
import { type ComponentKey, fieldLabel, type SourceInfo } from "@rpp/machine-view";
import { keyOf } from "./edits";
import type { Issue } from "./validation";

/**
 * How a component of the draft stands against its PLC (ADR 0016): the PLC program owns which components exist, so a
 * draft's component is matched with the PLC's manifest by source, manifest id and type.
 *
 * - `matched`: the PLC has it, with the same configuration.
 * - `changed`: the PLC has it, with another configuration: writing would change it.
 * - `draftOnly`: its source's PLC has no component with its id; nothing to write it to.
 * - `typeMismatch`: the PLC's component with its id is of another type.
 * - `noPlc`: the gateway reads no PLC of its source (e.g. a draft made offline).
 */
export type Match = "matched" | "changed" | "draftOnly" | "typeMismatch" | "noPlc";

export interface Reconciliation {
  matches: Record<ComponentKey, Match>;
  /** The PLCs' components that the draft does not have, in the PLCs' order. */
  plcOnly: ComponentConfig[];
  /** Per draft component the PLC's configuration of it, where the PLC has one of the same type. */
  plc: Map<ComponentKey, ComponentConfig>;
}

export function reconcile(draft: Draft, sources: readonly SourceInfo[]): Reconciliation {
  const plcComponents = new Map<ComponentKey, ComponentConfig>();
  const read = new Set<string>();
  for (const s of sources) {
    if (!s.config) continue;
    read.add(s.sourceId);
    for (const c of s.config.components) plcComponents.set(keyOf(c), c);
  }
  const matches: Record<ComponentKey, Match> = {};
  const plc = new Map<ComponentKey, ComponentConfig>();
  for (const c of draft.components) {
    const key = keyOf(c);
    const theirs = plcComponents.get(key);
    if (!read.has(c.sourceId)) matches[key] = "noPlc";
    else if (!theirs) matches[key] = "draftOnly";
    else if (theirs.type !== c.type) matches[key] = "typeMismatch";
    else {
      plc.set(key, theirs);
      matches[key] = sameConfig(theirs, c) ? "matched" : "changed";
    }
  }
  const plcOnly = [...plcComponents.entries()].filter(([key]) => !(key in matches)).map(([, c]) => c);
  return { matches, plcOnly, plc };
}

/** Equal configurations: the same values, in whatever order their fields were written. */
export function sameConfig(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Per configuration object its canonical text: configurations are never changed, only replaced (see `applyEdit`). */
const canonicalTexts = new WeakMap<object, string>();

function canonical(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  let text = canonicalTexts.get(value);
  if (text === undefined) canonicalTexts.set(value, (text = canonicalText(value)));
  return text;
}

function canonicalText(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Where the draft assumed other hardware than its PLC has (`HARDWARE_FIELDS`): a warning per value, e.g. a Delta's arm
 * length. The configurator never writes hardware, so the PLC's is what the machine has.
 */
export function hardwareHints(draft: Draft, plc: ReadonlyMap<ComponentKey, ComponentConfig>): Issue[] {
  const hints: Issue[] = [];
  for (const c of draft.components) {
    const key = keyOf(c);
    const theirs = plc.get(key) as Record<string, unknown> | undefined;
    if (!theirs) continue;
    const ours = c as unknown as Record<string, unknown>;
    for (const field of HARDWARE_FIELDS[c.type] as readonly string[]) {
      if (sameConfig(ours[field], theirs[field])) continue;
      const shown = (v: unknown) => (typeof v === "number" ? `${v} mm` : typeof v === "string" ? v : "different");
      hints.push({
        severity: "warning",
        hardware: true,
        key,
        message: `${c.name}: ${fieldLabel(field).toLowerCase()} is ${shown(ours[field])} in the draft, ${shown(theirs[field])} in the PLC`,
      });
    }
  }
  return hints;
}
