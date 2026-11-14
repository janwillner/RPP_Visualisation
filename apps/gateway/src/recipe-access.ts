import { z } from "zod";
import {
  FIELD_TEXT_CONFIG_PROTOCOL_VERSION,
  invalidRecipeValue,
  recipeProgramValue,
  MachineCommandStatusSchema,
  RecipeFieldSchema,
  type MachineCommand,
  type MachineCommandStatus,
  type ParametersMessage,
  type Recipe,
  type RecipeField,
  type RecipeValue,
  type ResetRecipeCommand,
  type WriteRecipeCommand,
} from "@rpp/protocol";
import { E_ConfigCommand } from "./config-contract";
import { mapPlc } from "./plc-mapping";
import type { ReadPart } from "./read-parts";
import { resetWrites, staleBase, stageWrites, stagingStatus } from "./staging";
import type { SymbolWrite } from "./symbol-access";

/**
 * The machine's recipe and its commands (library Syn_Config, config protocol 3, ADR 0022; labels, descriptions and
 * visibility conditions from config protocol 4, #49): the declared fields of the application's machine FB, its status
 * and effective values as part of the `parameters` message, and the leaf values that stage a recipe, a reset or a
 * machine command.
 */

/** The machine FB found in the config manifest (id 0, type NONE). */
export interface MachineFbEntry {
  /** Symbol path of its `vo_Config`. */
  path: string;
  /** The recipe fields the application declares, read at discovery. */
  fields: RecipeField[];
}

const DeclaredFieldSchema = RecipeFieldSchema.omit({ label: true, description: true, visibleWhen: true });
/** A field as config protocol 3 declares it. */
const DeclarationSchema = z.object({ fields: z.array(DeclaredFieldSchema) });
/** A field as config protocol 4 declares it: with its texts and its condition by field number (0 = always). */
const TextDeclarationSchema = z.object({
  fields: z.array(
    DeclaredFieldSchema.extend({
      label: z.string(),
      description: z.string(),
      visibleField: z.number().int(),
      visibleValue: z.number().int(),
    }),
  ),
});

/**
 * Reads the fields the application declares, of its config protocol. A layout the gateway does not know, or a field
 * without a name or with the name of another (the recipe is written by name), throws a TypeError, which discovery
 * reports. A visibility condition that cannot hold (`conditionProblems`) is left out and named in `errors`, so the
 * field is always shown.
 */
export function machineFbEntry(path: string, raw: unknown, protocolVersion: number): { entry: MachineFbEntry; errors: string[] } {
  const declared =
    protocolVersion >= FIELD_TEXT_CONFIG_PROTOCOL_VERSION
      ? mapPlc(TextDeclarationSchema, raw).fields
      : mapPlc(DeclarationSchema, raw).fields.map((f) => ({ ...f, label: "", description: "", visibleField: 0, visibleValue: 0 }));
  const named = declared.map((f) => ({ ...f, name: f.name.trim(), label: f.label.trim(), description: f.description.trim() }));
  for (const [i, f] of named.entries()) {
    if (f.name === "") throw new TypeError(`recipe field ${i + 1} has no name`);
    if (named.findIndex((other) => other.name === f.name) < i) throw new TypeError(`recipe field ${f.name} is declared twice`);
  }
  const problems = conditionProblems(named);
  const fields = named.map(({ visibleField, visibleValue, ...f }, i): RecipeField => ({
    ...f,
    visibleWhen: visibleField === 0 || problems.has(i) ? null : { field: named[visibleField - 1]!.name, value: visibleValue },
  }));
  return { entry: { path, fields }, errors: [...problems.values()] };
}

/**
 * The visibility conditions that cannot hold, by field index, with why: one on a field not declared, on the field
 * itself, on a number field (a condition compares whole numbers), on a value its field can never have, or in a ring of
 * fields depending on each other.
 */
function conditionProblems(
  fields: readonly (Pick<RecipeField, "name" | "type" | "min" | "max" | "choices"> & { visibleField: number; visibleValue: number })[],
): Map<number, string> {
  const problems = new Map<number, string>();
  const say = (i: number, why: string) => problems.set(i, `Recipe field ${fields[i]!.name} ${why}; it is always shown.`);
  for (const [i, f] of fields.entries()) {
    const on = f.visibleField;
    if (on === 0) continue;
    if (on < 0 || on > fields.length) say(i, `is shown only with field ${on}, which is not declared`);
    else if (on === i + 1) say(i, "depends on itself");
    else if (fields[on - 1]!.type === "number") say(i, `depends on ${fields[on - 1]!.name}, but ${fields[on - 1]!.name} is a number field`);
    else if (invalidRecipeValue(fields[on - 1]!, conditionValue(fields[on - 1]!, f.visibleValue)) !== undefined) {
      say(i, `is shown only with ${fields[on - 1]!.name} = ${f.visibleValue}, which ${fields[on - 1]!.name} can never have`);
    }
  }
  // A ring: following the conditions from a field comes back to it.
  for (const i of fields.keys()) {
    const seen: number[] = [];
    let at = i;
    while (!problems.has(at) && fields[at]!.visibleField !== 0 && !seen.includes(at)) {
      seen.push(at);
      at = fields[at]!.visibleField - 1;
    }
    if (at === i && seen.length > 1) {
      for (const j of seen) {
        const others = seen.filter((k) => k !== j).map((k) => fields[k]!.name);
        say(j, `and ${others.join(", ")} depend on each other`);
      }
    }
  }
  return problems;
}

/** A condition's whole number as a value of the field it reads: a switch's 0 / 1 as off / on. */
function conditionValue(field: Pick<RecipeField, "type">, value: number): RecipeValue {
  return field.type === "switch" ? (value === 0 ? false : value === 1 ? true : value) : value;
}

/** What the cyclic sum-read reads of the machine FB: the recipe's status, its effective values and the command answer. */
export function machineFbPart(m: MachineFbEntry): ReadPart<{ recipe: Recipe; machineCommand: MachineCommandStatus }> {
  return {
    paths: [`${m.path}.stStatus`, `${m.path}.aActive`, `${m.path}.stCommandStatus`],
    map: (raws) => machineParameters(m, raws),
    restart: () => {},
  };
}

/** The recipe and the command answer from the values read at `machineFbPart`'s paths. */
function machineParameters(
  m: MachineFbEntry,
  [status, active, commandStatus]: readonly unknown[],
): { recipe: Recipe; machineCommand: MachineCommandStatus } {
  const values = Object.fromEntries(
    m.fields.map((f, i): [string, RecipeValue] => {
      const v = (active as number[])[i] ?? 0;
      return [f.name, f.type === "switch" ? v !== 0 : v];
    }),
  );
  return {
    recipe: { fields: m.fields, ...stagingStatus(status), values },
    machineCommand: mapPlc(MachineCommandStatusSchema, commandStatus),
  };
}

export type RecipeCommand = WriteRecipeCommand | ResetRecipeCommand | MachineCommand;

const COMMAND_VALUES = { start: E_ConfigCommand.START, stop: E_ConfigCommand.STOP, reset: E_ConfigCommand.RESET } as const;

/**
 * The leaf values that carry out a recipe command in the order of one sum-write, or why its content cannot be: a
 * recipe's every value and its staging with `bStaged` last (a waiting one withdrawn first), a reset with `bReset` last,
 * a machine command with `bRequested` last. `id` is the stage or command id; `current` the last `parameters` message
 * with the active recipe. Whether the source takes recipe commands at all is `writeBlockedReason`'s, asked before.
 */
export function recipeWrites(
  command: RecipeCommand,
  machine: MachineFbEntry,
  current: ParametersMessage | undefined,
  id: number,
): { error: string } | { writes: SymbolWrite[] } {
  if (command.kind === "machineCommand") {
    const at = `${machine.path}.stCommand`;
    // A command still waiting is withdrawn first, so the application never takes the new id with the old command.
    return {
      writes: [
        { path: `${at}.bRequested`, value: false },
        { path: `${at}.nCommandId`, value: id },
        { path: `${at}.eCommand`, value: COMMAND_VALUES[command.command] },
        { path: `${at}.bRequested`, value: true },
      ],
    };
  }

  const recipe = current?.recipe;
  if (!recipe) return { error: "The recipe has not been read yet." };
  const stale = staleBase("The recipe has version", recipe.activeVersion, command.baseVersion);
  if (stale) return { error: stale };
  if (command.kind === "resetRecipe") return { writes: resetWrites(machine.path, command.baseVersion, id) };

  const unknown = Object.keys(command.values).find((name) => !machine.fields.some((f) => f.name === name));
  if (unknown !== undefined) return { error: `The recipe has no field ${unknown}.` };
  const staged: SymbolWrite[] = [];
  for (const [i, field] of machine.fields.entries()) {
    // Only what the client sends is checked: a field it leaves out keeps the value the application runs with.
    const sent = command.values[field.name];
    if (sent !== undefined) {
      const problem = invalidRecipeValue(field, sent);
      if (problem) return { error: problem };
    }
    const value = sent ?? recipe.values[field.name] ?? recipeProgramValue(field);
    staged.push({ path: `${machine.path}.aStaged[${i}]`, value: typeof value === "boolean" ? Number(value) : value });
  }
  return { writes: stageWrites(machine.path, command.baseVersion, id, staged) };
}
