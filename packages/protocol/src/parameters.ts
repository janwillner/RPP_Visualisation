import { z } from "zod";
import {
  ConfigMessageSchema,
  CartesianConfigSchema,
  ConveyorConfigSchema,
  DeltaConfigSchema,
  SensorConfigSchema,
  SourceIdSchema,
  StationConfigSchema,
  VisionConfigSchema,
  XtsGantryConfigSchema,
  XtsLoopConfigSchema,
  type ComponentConfig,
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

/** Version of the Syn_Config contract the gateway writes (3: recipe fields and machine commands, ADR 0022). */
export const CONFIG_PROTOCOL_VERSION = 3;

/** The oldest Syn_Config protocol the gateway still writes parameter sets to; it has no recipe and no commands. */
export const MIN_CONFIG_PROTOCOL_VERSION = 2;

/**
 * The configuration fields of each component type that a parameter set holds; hardware (lengths, arm geometry, strokes,
 * bodies) is never among them. An XTS track's modules and a gripper's fingers are: they are set up per machine (ADR 0016,
 * ADR 0018).
 */
export const PARAMETER_FIELDS = {
  conveyor: ["pose", "originShift", "productTypes"],
  delta: ["pose", "originShift", "zones", "fingers", "workingArea", "limitArea", "tcpLimitArea"],
  xtsGantry: ["pose", "originShift", "modules", "zones", "fingers", "limitArea", "tcpLimitArea"],
  xtsLoop: ["pose", "originShift", "modules", "zones", "fingers"],
  cartesian: ["pose", "originShift", "zones", "fingers", "limitArea", "tcpLimitArea"],
  vision: ["pose", "originShift", "zones"],
  sensor: ["pose", "originShift", "zones"],
  station: ["pose", "originShift", "zones"],
} as const satisfies { [T in ComponentType]: readonly (keyof Extract<ComponentConfig, { type: T }>)[] };
export type ParameterType = keyof typeof PARAMETER_FIELDS;

const base = { pose: true, originShift: true } as const;
const robot = { ...base, zones: true, fingers: true, limitArea: true, tcpLimitArea: true } as const;
const areas = "limit area and TCP limit area";

export const ConveyorParametersSchema = ConveyorConfigSchema.pick({ ...base, productTypes: true }).describe(
  "A conveyor's parameter set: its pose, origin shift and product types.",
);
export type ConveyorParameters = z.infer<typeof ConveyorParametersSchema>;

export const DeltaParametersSchema = DeltaConfigSchema.pick({ ...robot, workingArea: true }).describe(
  `A Delta robot's parameter set: its pose, origin shift, zones, gripper fingers, working area, ${areas}.`,
);
export type DeltaParameters = z.infer<typeof DeltaParametersSchema>;

export const XtsGantryParametersSchema = XtsGantryConfigSchema.pick({ ...robot, modules: true }).describe(
  `An XTS gantry's parameter set: its pose, origin shift, track modules, zones, gripper fingers, ${areas}.`,
);
export const XtsLoopParametersSchema = XtsLoopConfigSchema.pick({ ...base, modules: true, zones: true, fingers: true }).describe(
  "An XTS loop's parameter set: its pose, origin shift, track modules, zones and gripper fingers.",
);
export const CartesianParametersSchema = CartesianConfigSchema.pick(robot).describe(
  `A Cartesian robot's parameter set: its pose, origin shift, zones, gripper fingers, ${areas}.`,
);
export const VisionParametersSchema = VisionConfigSchema.pick({ ...base, zones: true }).describe(
  "A vision system's parameter set: its pose, origin shift and zones.",
);
export const SensorParametersSchema = SensorConfigSchema.pick({ ...base, zones: true }).describe(
  "A product sensor's parameter set: its pose, origin shift and zones.",
);
export const StationParametersSchema = StationConfigSchema.pick({ ...base, zones: true }).describe(
  "A station's parameter set: its pose, origin shift and zones.",
);

/** Each parameter type's schema, keyed like `PARAMETER_FIELDS`. */
export const PARAMETER_SCHEMAS = {
  conveyor: ConveyorParametersSchema,
  delta: DeltaParametersSchema,
  xtsGantry: XtsGantryParametersSchema,
  xtsLoop: XtsLoopParametersSchema,
  cartesian: CartesianParametersSchema,
  vision: VisionParametersSchema,
  sensor: SensorParametersSchema,
  station: StationParametersSchema,
} as const;

const typed = <T extends ParameterType>(type: T) =>
  z.object({
    type: z.literal(type).describe(`Component type: always \`${type}\`.`),
    parameters: PARAMETER_SCHEMAS[type],
  });

/** A parameter set with the type of the component it is for. */
export const TypedParametersSchema = z
  .discriminatedUnion("type", [
    typed("conveyor"),
    typed("delta"),
    typed("xtsGantry"),
    typed("xtsLoop"),
    typed("cartesian"),
    typed("vision"),
    typed("sensor"),
    typed("station"),
  ])
  .describe("A parameter set with the type of its component.");
export type TypedParameters = z.infer<typeof TypedParametersSchema>;

/** Every parameter type is one option of `TypedParametersSchema`: a type left out of it does not compile. */
const everyTypeTyped: [Exclude<ParameterType, TypedParameters["type"]>] extends [never] ? true : never = true;
void everyTypeTyped;

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
      "The machine's recipe (Syn_Config config protocol 3, ADR 0022); absent without a machine FB.",
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
