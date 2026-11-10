import type { ComponentState } from "@rpp/protocol";
import { faultText, singular } from "./machine-facts";

/**
 * A component's live values for the inspector, read from its state without knowing its type: every value the PLC
 * reports, except what the inspector shows elsewhere (identity, timestamp, fault, the product register). Lists such
 * as movers become tables; lists inside their entries (a mover's fingers) become tables of their own, one row per
 * entry, numbered after the entry they belong to.
 */
export interface StateValue {
  label: string;
  value: string;
}

export interface StateTable {
  title: string;
  head: string[];
  rows: string[][];
}

export interface StateRows {
  values: StateValue[];
  tables: StateTable[];
}

const SHOWN_ELSEWHERE = new Set(["type", "id", "timestamp", "fault", "products"]);

/** All lengths of the protocol are mm, all angles degrees. */
const unitOf = (key: string) => (key === "rx" || key === "ry" || key === "rz" ? "°" : "mm");

/** Abbreviations a field name holds, written as the domain writes them. */
const ABBREVIATIONS: Record<string, string> = { tcp: "TCP", ccs: "CCS" };

/** `gripperActive` → "Gripper active", `x` → "X", `tcpLimitArea` → "TCP limit area". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const isPosition = (v: unknown): v is { x: number; y: number; z: number } =>
  isObject(v) && Object.keys(v).join() === "x,y,z";

export function stateRows(state: ComponentState): StateRows {
  const values: StateValue[] = [];
  const tables = new Map<string, StateTable>();

  /** Rows of a list; `parent` numbers the entries of a list inside another list's entry. */
  const addTable = (key: string, entries: unknown[], parent?: string) => {
    const title = fieldLabel(key);
    entries.forEach((entry, i) => {
      if (!isObject(entry)) return;
      const number = "id" in entry ? String(entry.id) : parent ? `${parent}.${i + 1}` : String(i + 1);
      const head = ["id" in entry ? "Id" : singular(title)];
      const row = [number];
      // Created before the entry's own lists, so that a list comes before the lists inside it.
      let table = tables.get(title);
      if (!table) tables.set(title, (table = { title, head, rows: [] }));
      table.rows.push(row);
      const cell = (k: string, v: unknown) => {
        if (k === "id") return;
        if (k === "fault") {
          head.push("Fault");
          row.push(faultText(v as { message: string } | null) ?? "");
        } else if (typeof v === "number") {
          head.push(`${fieldLabel(k)} [${unitOf(k)}]`);
          row.push(v.toFixed(1));
        } else if (typeof v === "boolean") {
          head.push(fieldLabel(k));
          row.push(v ? "on" : "off");
        } else if (Array.isArray(v)) {
          addTable(k, v, number);
        } else if (isObject(v)) {
          for (const [sub, sv] of Object.entries(v)) cell(sub, sv);
        }
      };
      for (const [k, v] of Object.entries(entry)) cell(k, v);
    });
  };

  for (const [key, value] of Object.entries(state)) {
    if (SHOWN_ELSEWHERE.has(key)) continue;
    if (typeof value === "number") values.push({ label: fieldLabel(key), value: `${value.toFixed(1)} ${unitOf(key)}` });
    else if (typeof value === "boolean") values.push({ label: fieldLabel(key), value: value ? "on" : "off" });
    else if (isPosition(value)) {
      const text = (["x", "y", "z"] as const).map((k) => `${k.toUpperCase()} ${value[k].toFixed(1)}`).join(" · ");
      values.push({ label: fieldLabel(key), value: `${text} mm` });
    } else if (Array.isArray(value)) addTable(key, value);
  }
  return { values, tables: [...tables.values()] };
}
