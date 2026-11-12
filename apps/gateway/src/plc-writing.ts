import { z } from "zod";
import { countMemberOf, plcEnumValue } from "./plc-mapping";
import type { SymbolWrite } from "./symbol-access";

/**
 * The inverse of `plc-mapping.ts`: a neutral protocol value as the PLC leaf values to write, each by its symbol path,
 * guided by the protocol's zod schema and the contract's naming convention (`docs/plc-contract.md`):
 *
 * - A member is the protocol field with its Hungarian prefix: `f` for a number, `n` for a whole number, `b` for a
 *   switch, `s` for a text, `e` for an enumeration, `st` for a structure, `a` for an array: `start` → `fStart`,
 *   `conveyorId` → `nConveyorId`, `pose` → `stPose`, `zones` → `aZones`.
 * - An array also gets its count member (`nZoneCount`); its entries are written from index 0, as values are read.
 * - A structure for a value that may be null has a `bActive` member: null writes only `bActive := FALSE`.
 */
export function plcLeaves(schema: z.ZodTypeAny, value: unknown, path: string): SymbolWrite[] {
  if (schema instanceof z.ZodNullable) {
    if (value === null) return [{ path: `${path}.bActive`, value: false }];
    return [...plcLeaves(schema.unwrap(), value, path), { path: `${path}.bActive`, value: true }];
  }
  if (schema instanceof z.ZodObject) {
    const object = value as Record<string, unknown>;
    return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).flatMap(([key, field]) => {
      const member = `${prefixOf(field)}${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      const at = `${path}.${member}`;
      if (!(unwrap(field) instanceof z.ZodArray)) return plcLeaves(field, object[key], at);
      const entries = object[key] as unknown[];
      const element = (unwrap(field) as z.ZodArray<z.ZodTypeAny>).element;
      return [
        { path: `${path}.${countMemberOf(member)}`, value: entries.length },
        ...entries.flatMap((e, i) => plcLeaves(element, e, `${at}[${i}]`)),
      ];
    });
  }
  if (schema instanceof z.ZodEnum) return [{ path, value: plcEnumValue(schema, value as string) }];
  return [{ path, value: value as SymbolWrite["value"] }];
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  return schema instanceof z.ZodNullable ? unwrap(schema.unwrap()) : schema;
}

/** The Hungarian prefix of a member holding a value of `schema`. */
function prefixOf(schema: z.ZodTypeAny): string {
  const s = unwrap(schema);
  if (s instanceof z.ZodNumber) return s.isInt ? "n" : "f";
  if (s instanceof z.ZodBoolean) return "b";
  if (s instanceof z.ZodString) return "s";
  if (s instanceof z.ZodEnum) return "e";
  if (s instanceof z.ZodArray) return "a";
  return "st";
}
