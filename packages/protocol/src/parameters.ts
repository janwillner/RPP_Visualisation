import { z } from "zod";
import {
  COMPONENT_SCHEMAS,
  COMPONENT_TYPES,
  ConfigMessageSchema,
  SourceIdSchema,
  type ComponentType,
  StateMessageSchema,
  StatusMessageSchema,
  MachineReportSchema,
} from "./model";

/**
 * Parameter sets (ADR 0017): the part of a component's configuration the configurator writes to its PLC, where the
 * library Syn_Config stages it and the application takes it over. The fields are the protocol's own configuration
 * fields, so a draft's component gives its parameter set by picking them.
 */

/**
 * Version of the Syn_Config contract the gateway writes (3: recipe fields and machine commands, ADR 0022; 4: their
 * labels, descriptions and visibility conditions, #49).
 */
export const CONFIG_PROTOCOL_VERSION = 4;

/** The first config protocol with a machine FB: recipe fields and machine commands (ADR 0022). */
export const RECIPE_CONFIG_PROTOCOL_VERSION = 3;

/** The first config protocol whose recipe fields have a label, a description and a visibility condition (#49). */
export const FIELD_TEXT_CONFIG_PROTOCOL_VERSION = 4;

/** The oldest Syn_Config protocol the gateway still writes parameter sets to; it has no recipe and no commands. */
export const MIN_CONFIG_PROTOCOL_VERSION = 2;

/**
 * The configuration fields of each component type that a parameter set holds (`COMPONENT_SCHEMAS`' `parameters`):
 * hardware (lengths, arm geometry, strokes, bodies) is never among them. An XTS track's modules and a gripper's fingers
 * are: they are set up per machine (ADR 0016, ADR 0018).
 */
export const PARAMETER_FIELDS = Object.fromEntries(COMPONENT_TYPES.map((t) => [t, COMPONENT_SCHEMAS[t].parameters])) as {
  readonly [T in ComponentType]: (typeof COMPONENT_SCHEMAS)[T]["parameters"];
};
/** Every component type has a parameter set. */
export type ParameterType = ComponentType;

/** A component type's parameter set: its config schema cut to its parameter fields. */
type ConfigShape<T extends ComponentType> = (typeof COMPONENT_SCHEMAS)[T]["config"]["shape"];
type ParameterShape<T extends ComponentType> = {
  [K in Extract<(typeof COMPONENT_SCHEMAS)[T]["parameters"][number], keyof ConfigShape<T>>]: ConfigShape<T>[K];
};
type ParameterSchema<T extends ComponentType> = z.ZodObject<ParameterShape<T> extends z.ZodRawShape ? ParameterShape<T> : never>;

function parameterSchema(type: ComponentType): z.AnyZodObject {
  const { config, parameters, parameterDescription } = COMPONENT_SCHEMAS[type];
  const fields = Object.fromEntries(parameters.map((f) => [f, true as const]));
  return (config as unknown as z.AnyZodObject).pick(fields).describe(parameterDescription);
}

/** Each component type's parameter schema, keyed like `COMPONENT_SCHEMAS`. */
export const PARAMETER_SCHEMAS = Object.fromEntries(COMPONENT_TYPES.map((t) => [t, parameterSchema(t)])) as {
  readonly [T in ComponentType]: ParameterSchema<T>;
};

/** A parameter set with the type of the component it is for. */
export type TypedParameters = {
  [T in ComponentType]: { type: T; parameters: z.infer<ParameterSchema<T>> };
}[ComponentType];

const typed = (type: ComponentType) =>
  z.object({
    type: z.literal(type).describe(`Component type: always \`${type}\`.`),
    parameters: PARAMETER_SCHEMAS[type] as z.AnyZodObject,
  });

export const TypedParametersSchema = z
  .discriminatedUnion("type", COMPONENT_TYPES.map(typed) as [ReturnType<typeof typed>, ...ReturnType<typeof typed>[]])
  .describe("A parameter set with the type of its component.") as unknown as z.ZodType<TypedParameters>;

export const ParameterResultSchema = z
  .enum(["none", "pending", "applied", "rejected"])
  .describe(
    "What became of the last staged set: `none` (nothing staged since the PLC started), `pending` (staged, waiting " +
      "for the application to allow taking it over), `applied` or `rejected` (see `message`).",
  );
export type ParameterResult = z.infer<typeof ParameterResultSchema>;

const int = (description: string) => z.number().int().describe(description);

/** One parameter FB's status and the effective values it gives its application. */
export const ComponentParametersSchema = z
  .object({
    id: int("Manifest id of the Syn_Visu component the parameter set is for."),
    activeVersion: int("Version of the active parameter set; 0 while the application's program values apply."),
    handledStageId: int("The stage id of the last write the PLC handled (applied or rejected); 0 = none yet."),
    result: ParameterResultSchema,
    message: z.string().describe("Why the last staged set was rejected; empty otherwise."),
    set: TypedParametersSchema.describe("The effective values: the active set, or the program values while none is."),
  })
  .describe("A parameter FB's status and the effective values it gives its application.");
export type ComponentParameters = z.infer<typeof ComponentParametersSchema>;

/** How a recipe field's value is kept: a number, a whole number, a switch (on / off) or one of named choices. */
export const RecipeFieldTypeSchema = z
  .enum(["number", "integer", "switch", "choice"])
  .describe(
    "How a recipe field's value is kept: `number` (any number within min and max), `integer` (a whole number " +
      "within min and max), `switch` (true or false) or `choice` (the number of one of `choices`, from 0).",
  );
export type RecipeFieldType = z.infer<typeof RecipeFieldTypeSchema>;

/** When a recipe field applies: while another field has a value (#49). */
export const RecipeConditionSchema = z
  .object({
    field: z.string().describe("Name of the field the condition reads: a `switch`, `integer` or `choice` field."),
    value: int("The value it must have: a switch's 0 / 1, a choice's number, a whole number."),
  })
  .describe("A recipe field's visibility condition: it applies only while `field` has `value`.");
export type RecipeCondition = z.infer<typeof RecipeConditionSchema>;

/** One value of a recipe as the application declares it (ADR 0022). */
export const RecipeFieldSchema = z
  .object({
    name: z.string().describe("The field's name, unique in the recipe, e.g. `BeltSpeed`."),
    group: int("Manifest id of the component the field belongs to; 0 for the whole machine."),
    type: RecipeFieldTypeSchema,
    unit: z.string().describe("Unit of the value, e.g. `mm/s`; empty for none."),
    min: z.number().describe("Smallest value of a `number` or `integer` field."),
    max: z.number().describe("Largest value of a `number` or `integer` field."),
    programValue: z
      .number()
      .describe("The application's own value, which applies while no recipe is active (a switch: 1 = on)."),
    choices: z.array(z.string()).describe("The names of a `choice` field's values, from value 0; empty otherwise."),
    label: z
      .string()
      .describe("What the field is called on the page, in the application's words; empty: its name put into words."),
    description: z.string().describe("What the field is for, in the application's words; empty for none."),
    visibleWhen: RecipeConditionSchema.nullable().describe(
      "The field applies only while another field has a value (config protocol 4); null: always. A field whose " +
        "condition's field does not apply does not apply either.",
    ),
  })
  .describe("One field of the recipe, as the application declares it.");
export type RecipeField = z.infer<typeof RecipeFieldSchema>;

/** A recipe value: a number, or a switch's on / off. */
export const RecipeValueSchema = z
  .union([z.number(), z.boolean()])
  .describe("A recipe value: `true` / `false` for a `switch`, a number for every other field.");
export type RecipeValue = z.infer<typeof RecipeValueSchema>;

/** The machine's recipe: its declared fields, the status of the last write and the effective values (ADR 0022). */
export const RecipeSchema = z
  .object({
    fields: z.array(RecipeFieldSchema).describe("Every field the application declares, in its order."),
    activeVersion: int("Version of the active recipe; 0 while the application's program values apply."),
    handledStageId: int("The stage id of the last recipe write the PLC handled; 0 = none yet."),
    result: ParameterResultSchema,
    message: z.string().describe("Why the last staged recipe was rejected; empty otherwise."),
    values: z
      .record(RecipeValueSchema)
      .describe("The effective value of every field by its name: the active recipe, or the program values."),
  })
  .describe("The machine's recipe: the process values its application declares and runs with.");
export type Recipe = z.infer<typeof RecipeSchema>;

/** What a write sets: a component's parameter set, the machine's recipe, or a machine command (Start, Stop, Reset). */
export type WriteKind = "parameters" | "recipe" | "machineCommand";

/** What a client command writes: its parameter set, the recipe (written or reset) or a machine command. */
export function writeKindOf(
  commandKind: "writeParameters" | "resetParameters" | "writeRecipe" | "resetRecipe" | "machineCommand",
): WriteKind {
  switch (commandKind) {
    case "writeParameters":
    case "resetParameters":
      return "parameters";
    case "writeRecipe":
    case "resetRecipe":
      return "recipe";
    case "machineCommand":
      return "machineCommand";
  }
}

/** What decides whether a source can be written now, as the gateway and the pages both know it. */
export interface WriteFacts {
  /** The PLC is connected. */
  online: boolean;
  /**
   * Its Syn_Config as the `parameters` message reports it: whether the gateway writes to it and why not, and the
   * recipe while the application has a machine FB. Undefined for a PLC without Syn_Config.
   */
  parameters: { writable: boolean; reason?: string | undefined; recipe?: unknown } | undefined;
  /** The machine entry reports simulation mode (protocol 22): recipes and machine commands go only to such a machine. */
  simulation: boolean;
}

export const NOT_CONNECTED = "The PLC is not connected.";
export const NO_MACHINE_FB =
  "The PLC's application has no machine FB (Syn_Config 2.1 or later, _FB_ConfigMachine): no recipe and no machine commands.";
export const NOT_SIMULATED =
  "The PLC is not in simulation mode: recipes and machine commands go only to a machine that runs without real hardware.";

/**
 * Why a write of `kind` cannot go to a source now; undefined when it can. The one rule the gateway refuses commands by
 * and the configurator and the Simulator block their writes by: the PLC connected, Syn_Config, the gateway allowed to
 * write, and for a recipe or a machine command also a machine FB and simulation mode.
 */
export function writeBlockedReason(kind: WriteKind, facts: WriteFacts): string | undefined {
  const { online, parameters, simulation } = facts;
  if (!online) return NOT_CONNECTED;
  if (!parameters) return kind === "parameters" ? "The PLC has no Syn_Config: its components cannot be written." : NO_MACHINE_FB;
  if (!parameters.writable) return parameters.reason ?? "The PLC cannot be written.";
  if (kind === "parameters") return undefined;
  if (!parameters.recipe) return NO_MACHINE_FB;
  if (!simulation) return NOT_SIMULATED;
  return undefined;
}

/** The value a field has while no recipe is active: its program value, a switch's as on / off. */
export function recipeProgramValue(field: RecipeField): RecipeValue {
  return field.type === "switch" ? field.programValue !== 0 : field.programValue;
}

/** Why `value` is not one of `field`'s (its type, its range, its choices); undefined when it is. */
export function invalidRecipeValue(
  field: Pick<RecipeField, "name" | "type" | "min" | "max" | "choices">,
  value: RecipeValue,
): string | undefined {
  const { name, type, min, max } = field;
  switch (type) {
    case "switch":
      return typeof value === "boolean" ? undefined : `${name} must be true or false.`;
    case "choice": {
      const last = field.choices.length - 1;
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= last
        ? undefined
        : `${name} must be one of its choices, 0 to ${last}.`;
    }
    case "integer":
      return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
        ? undefined
        : `${name} must be a whole number from ${min} to ${max}.`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
        ? undefined
        : `${name} must be a number from ${min} to ${max}.`;
  }
}

/** What a client may ask the machine to do. */
export const MachineCommandKindSchema = z
  .enum(["start", "stop", "reset"])
  .describe("What the machine is asked to do: `start`, `stop` or `reset`.");
export type MachineCommandKind = z.infer<typeof MachineCommandKindSchema>;

/** What the application made of the last machine command. */
export const MachineCommandStatusSchema = z
  .object({
    handledCommandId: int("The command id of the last command the application answered; 0 = none yet."),
    result: z
      .enum(["none", "accepted", "rejected"])
      .describe("What the application made of it: `none` (nothing asked yet), `accepted` or `rejected`."),
    message: z.string().describe("Why the application rejected it; empty otherwise."),
  })
  .describe("The application's answer to the last machine command (Start, Stop, Reset).");
export type MachineCommandStatus = z.infer<typeof MachineCommandStatusSchema>;

export const ParametersMessageSchema = z
  .object({
    kind: z.literal("parameters").describe("Message kind: always `parameters`."),
    sourceId: SourceIdSchema,
    writable: z
      .boolean()
      .describe("Parameter sets can be written to this source: it has Syn_Config and the gateway allows writing."),
    reason: z.string().describe("Why the source is not writable; absent when it is.").optional(),
    components: z.array(ComponentParametersSchema).describe("Every parameter FB of the source's config manifest."),
    recipe: RecipeSchema.describe(
      "The machine's recipe (Syn_Config config protocol 3 or later, ADR 0022); absent without a machine FB.",
    ).optional(),
    machineCommand: MachineCommandStatusSchema.describe(
      "The application's answer to the last machine command; absent without a machine FB.",
    ).optional(),
  })
  .describe(
    "The parameter sets of one source (ADR 0017). Sent after discovery, whenever a status or an active set changes, " +
      "and to every new client right after it connects.",
  );
export type ParametersMessage = z.infer<typeof ParametersMessageSchema>;

const commandFields = {
  requestId: int("Chosen by the client; the gateway's `writeResult` names it."),
  sourceId: SourceIdSchema,
  componentId: int("Manifest id of the component."),
  baseVersion: int("The active version the client knows; another active version refuses the command."),
};

/** Sent by a client: stage a parameter set on one component (ADR 0017). */
export const WriteParametersCommandSchema = z
  .object({
    kind: z.literal("writeParameters").describe("Command kind: always `writeParameters`."),
    ...commandFields,
    set: TypedParametersSchema,
  })
  .describe("Stage a parameter set on one component; only on a gateway started with `--allow-write`.");
export type WriteParametersCommand = z.infer<typeof WriteParametersCommandSchema>;

/** Sent by a client: make a component's active set invalid, so its application's program values apply again. */
export const ResetParametersCommandSchema = z
  .object({
    kind: z.literal("resetParameters").describe("Command kind: always `resetParameters`."),
    ...commandFields,
  })
  .describe("Return a component to its application's program values; only with `--allow-write`.");
export type ResetParametersCommand = z.infer<typeof ResetParametersCommandSchema>;

const recipeFields = {
  requestId: int("Chosen by the client; the gateway's `writeResult` names it."),
  sourceId: SourceIdSchema,
};

/** Sent by a client: stage the machine's recipe (ADR 0022). */
export const WriteRecipeCommandSchema = z
  .object({
    kind: z.literal("writeRecipe").describe("Command kind: always `writeRecipe`."),
    ...recipeFields,
    baseVersion: int("The active recipe version the client knows; another active version refuses the command."),
    values: z.record(RecipeValueSchema).describe("New values by field name; a field left out keeps its effective value."),
  })
  .describe(
    "Stage the machine's recipe; only with `--allow-write` and while the PLC reports simulation mode. Refused for an " +
      "unknown field, a value of the wrong type or outside min and max.",
  );
export type WriteRecipeCommand = z.infer<typeof WriteRecipeCommandSchema>;

/** Sent by a client: make the active recipe invalid, so the application's program values apply again. */
export const ResetRecipeCommandSchema = z
  .object({
    kind: z.literal("resetRecipe").describe("Command kind: always `resetRecipe`."),
    ...recipeFields,
    baseVersion: int("The active recipe version the client knows; another active version refuses the command."),
  })
  .describe("Return the machine to its application's program values; as `writeRecipe`, only in simulation mode.");
export type ResetRecipeCommand = z.infer<typeof ResetRecipeCommandSchema>;

/** Sent by a client: ask the machine to start, stop or reset (ADR 0022). */
export const MachineCommandSchema = z
  .object({
    kind: z.literal("machineCommand").describe("Command kind: always `machineCommand`."),
    ...recipeFields,
    command: MachineCommandKindSchema,
  })
  .describe(
    "Ask the machine to start, stop or reset; only with `--allow-write` and while the PLC reports simulation mode. " +
      "The application accepts or rejects it: `machineCommand` in `parameters`.",
  );
export type MachineCommand = z.infer<typeof MachineCommandSchema>;

export const ClientMessageSchema = z
  .discriminatedUnion("kind", [
    WriteParametersCommandSchema,
    ResetParametersCommandSchema,
    WriteRecipeCommandSchema,
    ResetRecipeCommandSchema,
    MachineCommandSchema,
  ])
  .describe("A command a client sends on the WebSocket; the gateway ignores anything else.");
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** The gateway's answer to a command, sent to the client that sent it only. */
export const WriteResultMessageSchema = z
  .object({
    kind: z.literal("writeResult").describe("Message kind: always `writeResult`."),
    requestId: int("The command's `requestId`."),
    ok: z
      .boolean()
      .describe("The set was staged (or the reset requested); whether the PLC takes it over follows in `parameters`."),
    stageId: int(
      "Stage id of the write (of a machine command: its command id); `handledStageId` (`handledCommandId`) in " +
        "`parameters` names it once the PLC handled it.",
    ).optional(),
    error: z.string().describe("Why the command was refused; absent when `ok`.").optional(),
  })
  .describe("The gateway's answer to a command, sent to the client that sent it.");
export type WriteResultMessage = z.infer<typeof WriteResultMessageSchema>;

/** Everything the gateway sends on the WebSocket. */
export const ServerMessageSchema = z
  .discriminatedUnion("kind", [
    ConfigMessageSchema,
    StateMessageSchema,
    StatusMessageSchema,
    MachineReportSchema,
    ParametersMessageSchema,
    WriteResultMessageSchema,
  ])
  .describe("Every message the gateway sends on the WebSocket, one JSON object per WebSocket text message.");
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
