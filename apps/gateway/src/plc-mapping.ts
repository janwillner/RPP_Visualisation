import { z } from "zod";
import { enumValue, type PlcEnum } from "./plc-contract";

/**
 * Maps a PLC structure (library Syn_Visu) to a neutral protocol value, guided by the protocol's zod schema, so that
 * no component needs its own mapping code. The PLC structures follow these conventions (`docs/plc-contract.md`):
 *
 * - A member is the protocol field with a Hungarian prefix and an upper-case first letter: `fLength` → `length`,
 *   `stOriginShift` → `originShift`, `aZones` → `zones`.
 * - An array `aZones` is cut to the count member `nZoneCount` when there is one; entries with a `bValid` member are
 *   kept only when it is TRUE.
 * - A structure for a field that may be null (e.g. a fault) has a `bActive` member: FALSE means null.
 * - An enumeration's value is its index in the protocol's enum, unless a table is registered (`ENUM_TABLES`);
 *   an unknown value maps to the first option.
 * - A 64-bit timestamp becomes a decimal string.
 *
 * A missing member throws a TypeError, which discovery reports for that entry only.
 */
export function mapPlc<S extends z.ZodTypeAny>(schema: S, raw: unknown, fixed: Record<string, unknown> = {}): z.infer<S> {
  return mapValue(schema, raw, "", fixed) as z.infer<S>;
}

/**
 * PLC values of enumerations that do not count from 0 in the order of the protocol's options, keyed by those options:
 * a field's schema is a described copy of the shared enum (`.describe()`), not the same instance.
 */
const ENUM_TABLES = new Map<string, Record<number, string>>();

const enumKey = (options: readonly string[]) => JSON.stringify(options);

/** Registers the PLC values of an enumeration whose values are not the index of its protocol option. */
export function registerEnumTable(schema: z.ZodEnum<[string, ...string[]]>, table: Record<number, string>): void {
  ENUM_TABLES.set(enumKey(schema.options), table);
}

/** Protocol fields whose PLC member has another name, tried after the conventional one. */
const ALIASES: Record<string, string> = {
  /** Live states of the config's lists sit in the state as `aFingerStates`, `aBodyStates` and `aModuleStates`. */
  fingers: "fingerStates",
  bodies: "bodyStates",
  modules: "moduleStates",
};

/** `fLength` → `length`, `stOriginShift` → `originShift`. */
function protocolName(member: string): string {
  const name = member.replace(/^[a-z]+(?=[A-Z])/, "");
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** How one protocol field is read from its PLC structure. */
interface FieldPlan {
  key: string;
  schema: z.ZodTypeAny;
  member: string;
  /** Count member of an array, if the structure has one. */
  countMember: string | undefined;
}

/** Member names resolved once per schema and PLC structure layout, since they do not change between cycles. */
const PLANS = new WeakMap<z.ZodTypeAny, FieldPlan[]>();

function structure(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) throw new TypeError(`${path || "value"} is not a structure`);
  return raw as Record<string, unknown>;
}

function planFor(schema: z.ZodObject<z.ZodRawShape>, raw: Record<string, unknown>, fixed: Record<string, unknown>, path: string): FieldPlan[] {
  const cached = PLANS.get(schema);
  if (cached && cached.every((f) => f.member in raw)) return cached;
  const byName = new Map<string, string>();
  for (const member of Object.keys(raw)) byName.set(protocolName(member), member);
  const fields: FieldPlan[] = [];
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
    if (key in fixed) continue;
    const name = byName.has(key) ? key : ALIASES[key];
    const member = name === undefined ? undefined : byName.get(name);
    if (member === undefined) throw new TypeError(`${path ? `${path}.` : ""}${key} is missing`);
    fields.push({ key, schema: field, member, countMember: name === undefined ? undefined : byName.get(`${singular(name)}Count`) });
  }
  // Fixed values differ only for the top-level structure, which is never nested elsewhere.
  PLANS.set(schema, fields);
  return fields;
}

function mapValue(schema: z.ZodTypeAny, raw: unknown, path: string, fixed: Record<string, unknown> = {}): unknown {
  if (schema instanceof z.ZodNullable) {
    const s = structure(raw, path);
    if (!("bActive" in s)) throw new TypeError(`${path} has no bActive member`);
    return s.bActive ? mapValue(schema.unwrap(), raw, path) : null;
  }
  if (schema instanceof z.ZodObject) {
    const s = structure(raw, path);
    const result: Record<string, unknown> = { ...fixed };
    for (const f of planFor(schema, s, fixed, path)) {
      const value = s[f.member];
      result[f.key] =
        f.schema instanceof z.ZodArray
          ? mapArray(f.schema, value, f.countMember && s[f.countMember], `${path}.${f.key}`)
          : mapValue(f.schema, value, `${path}.${f.key}`);
    }
    return result;
  }
  if (schema instanceof z.ZodEnum) {
    const options = schema.options as string[];
    const value = enumValue(raw as PlcEnum);
    const table = ENUM_TABLES.get(enumKey(options));
    const option = table ? table[value] : options[value];
    return option !== undefined && options.includes(option) ? option : options[0];
  }
  if (schema instanceof z.ZodString) {
    return typeof raw === "bigint" || typeof raw === "number" ? BigInt(raw).toString() : raw;
  }
  if (schema instanceof z.ZodArray) return mapArray(schema, raw, undefined, path);
  return raw;
}

function mapArray(schema: z.ZodArray<z.ZodTypeAny>, raw: unknown, count: unknown, path: string): unknown[] {
  if (!Array.isArray(raw)) throw new TypeError(`${path} is not an array`);
  const entries = typeof count === "number" ? raw.slice(0, Math.max(0, Math.min(count, raw.length))) : raw;
  // Mapped before the bValid filter, so that an error names the entry's index in the PLC array.
  const valid = (e: unknown) => !(typeof e === "object" && e !== null && "bValid" in e) || (e as { bValid: unknown }).bValid;
  return entries.flatMap((e, i) => (valid(e) ? [mapValue(schema.element, e, `${path}[${i}]`)] : []));
}

/** `zones` → `zone`, `bodies` → `body`: the count member is named after one entry. */
function singular(name: string): string {
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  return name.endsWith("s") ? name.slice(0, -1) : name;
}
