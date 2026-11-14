import { z } from "zod";
import {
  CONFIG_PROTOCOL_VERSION,
  invalidRecipeValue,
  recipeProgramValue,
  MachineCommandStatusSchema,
  ParameterResultSchema,
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
import type { ParameterDiscovery } from "./parameter-access";
import { mapPlc } from "./plc-mapping";
import type { SymbolWrite } from "./symbol-access";

/**
 * The machine's recipe and its commands (library Syn_Config, config protocol 3, ADR 0022): the declared fields of the
 * application's machine FB, its status and effective values as part of the `parameters` message, and the leaf values
 * that stage a recipe, a reset or a machine command.
 */

/** The machine FB found in the config manifest (id 0, type NONE). */
export interface MachineFbEntry {
  /** Symbol path of its `vo_Config`. */
  path: string;
  /** The recipe fields the application declares, read at discovery. */
  fields: RecipeField[];
}

const DeclarationSchema = z.object({ fields: z.array(RecipeFieldSchema) });

const StatusSchema = z.object({
  activeVersion: z.number().int(),
  handledStageId: z.number().int(),
  result: ParameterResultSchema,
  message: z.string(),
});

/**
 * Reads the fields the application declares. A layout the gateway does not know, or a field without a name or with
 * the name of another (the recipe is written by name), throws a TypeError, which discovery reports.
 */
export function machineFbEntry(path: string, raw: unknown): MachineFbEntry {
  const fields = mapPlc(DeclarationSchema, raw).fields.map((f) => ({ ...f, name: f.name.trim() }));
  for (const [i, f] of fields.entries()) {
    if (f.name === "") throw new TypeError(`recipe field ${i + 1} has no name`);
    if (fields.findIndex((other) => other.name === f.name) < i) throw new TypeError(`recipe field ${f.name} is declared twice`);
  }
  return { path, fields };
}

/** What the cyclic sum-read reads of the machine FB: the recipe's status, its effective values and the command answer. */
export function machineReadPaths(m: MachineFbEntry): string[] {
  return [`${m.path}.stStatus`, `${m.path}.aActive`, `${m.path}.stCommandStatus`];
}

/** The recipe and the command answer from the values read at `machineReadPaths`. */
export function machineParameters(
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
    recipe: { fields: m.fields, ...mapPlc(StatusSchema, status), values },
    machineCommand: mapPlc(MachineCommandStatusSchema, commandStatus),
  };
}

export type RecipeCommand = WriteRecipeCommand | ResetRecipeCommand | MachineCommand;

/** What a recipe command needs to know about the source besides its Syn_Config discovery. */
export interface RecipeContext {
  /** The PLC reports simulation mode (machine entry, protocol 22). */
  simulation: boolean;
  /** The last `parameters` message: the active recipe. */
  current: ParametersMessage | undefined;
}

export const NOT_SIMULATED =
  "The PLC is not in simulation mode: recipes and machine commands go only to a machine that runs without real hardware.";

const COMMAND_VALUES = { start: E_ConfigCommand.START, stop: E_ConfigCommand.STOP, reset: E_ConfigCommand.RESET } as const;

/**
 * Why a recipe command cannot be carried out, or the leaf values that carry it out in the order of one sum-write: a
 * recipe's every value and its staging with `bStaged` last (a waiting one withdrawn first), a reset with `bReset` last,
 * a machine command with `bRequested` last. `id` is the stage or command id.
 */
export function recipeWrites(
  command: RecipeCommand,
  discovery: Pick<ParameterDiscovery, "reason" | "protocolVersion" | "machine">,
  ctx: RecipeContext,
  id: number,
): { error: string } | { writes: SymbolWrite[] } {
  if (discovery.reason !== undefined) return { error: discovery.reason };
  if (discovery.protocolVersion < CONFIG_PROTOCOL_VERSION) {
    return {
      error: `The PLC's Syn_Config has config protocol ${discovery.protocolVersion}: recipes and machine commands need ${CONFIG_PROTOCOL_VERSION}.`,
    };
  }
  const machine = discovery.machine;
  if (!machine) {
    return { error: "The PLC's application has no machine FB (Syn_Config _FB_ConfigMachine): no recipe and no machine commands." };
  }
  if (!ctx.simulation) return { error: NOT_SIMULATED };

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

  const recipe = ctx.current?.recipe;
  if (!recipe) return { error: "The recipe has not been read yet." };
  if (recipe.activeVersion !== command.baseVersion) {
    return { error: `The recipe has version ${recipe.activeVersion} active, not ${command.baseVersion}: reconcile again before writing.` };
  }
  const staging = `${machine.path}.stStaging`;
  const head: SymbolWrite[] = [
    { path: `${staging}.nBaseVersion`, value: command.baseVersion },
    { path: `${staging}.nStageId`, value: id },
  ];
  if (command.kind === "resetRecipe") return { writes: [...head, { path: `${staging}.bReset`, value: true }] };

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
  // A recipe still waiting to be allowed is withdrawn first, so it is never taken over half overwritten.
  return {
    writes: [
      { path: `${staging}.bStaged`, value: false },
      ...staged,
      ...head,
      { path: `${staging}.bReset`, value: false },
      { path: `${staging}.bStaged`, value: true },
    ],
  };
}
