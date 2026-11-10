import { COMPONENT_SCHEMAS, type ComponentConfig } from "@rpp/protocol";
import { singular } from "../machine-facts";
import { fieldLabel } from "../state-rows";

/**
 * The values of a component the property panel edits, read from its type's config schema without knowing the type:
 * every number, text, switch and choice, grouped by the objects they sit in (pose, origin shift, working area), and
 * every entry of its lists (zones, product types, fingers) as a group of its own. Optional areas come later.
 */

export type PropertyField =
  | { kind: "number"; path: string[]; key: string; label: string; unit: string; integer: boolean; value: number; hint: string }
  | { kind: "text"; path: string[]; key: string; label: string; value: string; hint: string }
  | { kind: "switch"; path: string[]; key: string; label: string; value: boolean; hint: string }
  | { kind: "choice"; path: string[]; key: string; label: string; options: string[]; value: string; hint: string };

export interface PropertyGroup {
  /** Empty for the component's own values. */
  title: string;
  fields: PropertyField[];
  /** For an entry of a list: the list's field name and the entry's index, so it can be removed. */
  entry?: { list: string; index: number };
}

/** A list of the component, e.g. its zones, under which its entries are shown. */
export interface PropertyList {
  name: string;
  title: string;
  /** The schema's description of the list. */
  hint: string;
}

export interface Properties {
  groups: PropertyGroup[];
  lists: PropertyList[];
}

/** Shown elsewhere: the type in the panel's head. */
const SKIPPED = new Set(["type"]);

/** What the panel needs of a zod schema; read through `_def`, so the web app needs no zod of its own. */
interface SchemaLike {
  description?: string;
  _def: {
    typeName: string;
    checks?: { kind: string }[];
    values?: string[];
    shape?: () => Record<string, SchemaLike>;
    type?: SchemaLike;
  };
}

/** All lengths of the protocol are mm, all angles degrees. */
const unitOf = (key: string) => (key === "rx" || key === "ry" || key === "rz" ? "°" : "mm");

export function properties(component: ComponentConfig): Properties {
  const schema = COMPONENT_SCHEMAS[component.type].config as unknown as SchemaLike;
  const groups: PropertyGroup[] = [{ title: "", fields: [] }];
  const lists: PropertyList[] = [];
  const entries: PropertyGroup[] = [];
  /** `prefix`: put before the labels of an object inside a list entry, whose fields stay in the entry's group. */
  const walk = (
    shape: Record<string, SchemaLike>,
    values: Record<string, unknown>,
    path: string[],
    group: PropertyGroup,
    prefix = "",
  ) => {
    for (const [key, field] of Object.entries(shape)) {
      if (path.length === 0 && SKIPPED.has(key)) continue;
      const at = [...path, key];
      const value = values[key];
      const label = prefix ? `${prefix} ${fieldLabel(key)}` : fieldLabel(key);
      const base = { path: at, key, label, hint: field.description ?? "" };
      switch (field._def.typeName) {
        case "ZodNumber": {
          const integer = field._def.checks?.some((c) => c.kind === "int") ?? false;
          group.fields.push({ kind: "number", ...base, unit: integer ? "" : unitOf(key), integer, value: value as number });
          break;
        }
        case "ZodString":
          group.fields.push({ kind: "text", ...base, value: value as string });
          break;
        case "ZodBoolean":
          group.fields.push({ kind: "switch", ...base, value: value as boolean });
          break;
        case "ZodEnum":
          group.fields.push({ kind: "choice", ...base, options: field._def.values ?? [], value: value as string });
          break;
        case "ZodObject": {
          // Inside a list entry (a body's pose) the fields stay with the entry; elsewhere the object is a group.
          if (group.entry) {
            walk(field._def.shape!(), value as Record<string, unknown>, at, group, label);
            break;
          }
          const inner: PropertyGroup = { title: fieldLabel(key), fields: [] };
          groups.push(inner);
          walk(field._def.shape!(), value as Record<string, unknown>, at, inner);
          break;
        }
        case "ZodArray": {
          const item = field._def.type;
          if (path.length > 0 || item?._def.typeName !== "ZodObject") break;
          const title = fieldLabel(key);
          lists.push({ name: key, title, hint: field.description ?? "" });
          (value as Record<string, unknown>[]).forEach((entry, index) => {
            const inner: PropertyGroup = { title: `${singular(title)} ${index + 1}`, fields: [], entry: { list: key, index } };
            entries.push(inner);
            walk(item._def.shape!(), entry, [key, String(index)], inner);
          });
          break;
        }
        // Optional values (limit areas) come with their own editor.
      }
    }
  };
  walk(schema._def.shape!(), component as unknown as Record<string, unknown>, [], groups[0]!);
  return { groups: [...groups, ...entries].filter((g) => g.fields.length > 0), lists };
}
