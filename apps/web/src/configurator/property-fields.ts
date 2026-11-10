import { COMPONENT_SCHEMAS, type ComponentConfig } from "@rpp/protocol";
import { fieldLabel } from "../state-rows";

/**
 * The values of a component the property panel edits, read from its type's config schema without knowing the type:
 * every number, text, switch and choice, grouped by the objects they sit in (pose, origin shift, working area). Lists
 * (zones, fingers, product types) and optional areas are edited elsewhere.
 */

export type PropertyField =
  | { kind: "number"; path: string[]; label: string; unit: string; integer: boolean; value: number; hint: string }
  | { kind: "text"; path: string[]; label: string; value: string; hint: string }
  | { kind: "switch"; path: string[]; label: string; value: boolean; hint: string }
  | { kind: "choice"; path: string[]; label: string; options: string[]; value: string; hint: string };

export interface PropertyGroup {
  /** Empty for the component's own values. */
  title: string;
  fields: PropertyField[];
}

/** Shown elsewhere: the type in the panel's head. */
const SKIPPED = new Set(["type"]);

/** What the panel needs of a zod schema; read through `_def`, so the web app needs no zod of its own. */
interface SchemaLike {
  description?: string;
  _def: { typeName: string; checks?: { kind: string }[]; values?: string[]; shape?: () => Record<string, SchemaLike> };
}

/** All lengths of the protocol are mm, all angles degrees. */
const unitOf = (key: string) => (key === "rx" || key === "ry" || key === "rz" ? "°" : "mm");

export function propertyGroups(component: ComponentConfig): PropertyGroup[] {
  const schema = COMPONENT_SCHEMAS[component.type].config as unknown as SchemaLike;
  const groups: PropertyGroup[] = [{ title: "", fields: [] }];
  const walk = (shape: Record<string, SchemaLike>, values: Record<string, unknown>, path: string[], group: PropertyGroup) => {
    for (const [key, field] of Object.entries(shape)) {
      if (path.length === 0 && SKIPPED.has(key)) continue;
      const at = [...path, key];
      const value = values[key];
      const base = { path: at, label: fieldLabel(key), hint: field.description ?? "" };
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
          const inner: PropertyGroup = { title: fieldLabel(key), fields: [] };
          groups.push(inner);
          walk(field._def.shape!(), value as Record<string, unknown>, at, inner);
          break;
        }
        // Lists and optional values (zones, fingers, product types, limit areas) come with later editors.
      }
    }
  };
  walk(schema._def.shape!(), component as unknown as Record<string, unknown>, [], groups[0]!);
  return groups.filter((g) => g.fields.length > 0);
}
