import { z } from "zod";
import {
  ConfigMessageSchema,
  ConveyorConfigSchema,
  DeltaConfigSchema,
  SourceIdSchema,
  StateMessageSchema,
  StatusMessageSchema,
} from "./model";

/**
 * Parameter sets (ADR 0017): the part of a component's configuration the configurator writes to its PLC, where the
 * library Syn_Config stages it and the application takes it over. The fields are the protocol's own configuration
 * fields, so a draft's component gives its parameter set by picking them.
 */

/** Version of the Syn_Config contract. Must match `nProtocolVersion` in the PLC's config manifest. */
export const CONFIG_PROTOCOL_VERSION = 1;

/** The configuration fields of each component type that a parameter set holds; hardware is never among them. */
export const PARAMETER_FIELDS = {
  conveyor: ["pose", "originShift", "productTypes"],
  delta: ["pose", "originShift", "zones", "workingArea", "limitArea", "tcpLimitArea"],
} as const;
export type ParameterType = keyof typeof PARAMETER_FIELDS;

export const ConveyorParametersSchema = ConveyorConfigSchema.pick({
  pose: true,
  originShift: true,
  productTypes: true,
}).describe("A conveyor's parameter set: its pose, origin shift and product types.");
export type ConveyorParameters = z.infer<typeof ConveyorParametersSchema>;

export const DeltaParametersSchema = DeltaConfigSchema.pick({
  pose: true,
  originShift: true,
  zones: true,
  workingArea: true,
  limitArea: true,
  tcpLimitArea: true,
}).describe("A Delta robot's parameter set: its pose, origin shift, zones, working area, limit area and TCP limit area.");
export type DeltaParameters = z.infer<typeof DeltaParametersSchema>;

/** Each parameter type's schema, keyed like `PARAMETER_FIELDS`. */
export const PARAMETER_SCHEMAS = { conveyor: ConveyorParametersSchema, delta: DeltaParametersSchema } as const;

/** A parameter set with the type of the component it is for. */
export const TypedParametersSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("conveyor").describe("Component type: always `conveyor`."),
      parameters: ConveyorParametersSchema,
    }),
    z.object({
      type: z.literal("delta").describe("Component type: always `delta`."),
      parameters: DeltaParametersSchema,
    }),
  ])
  .describe("A parameter set with the type of its component.");
export type TypedParameters = z.infer<typeof TypedParametersSchema>;

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

export const ParametersMessageSchema = z
  .object({
    kind: z.literal("parameters").describe("Message kind: always `parameters`."),
    sourceId: SourceIdSchema,
    writable: z
      .boolean()
      .describe("Parameter sets can be written to this source: it has Syn_Config and the gateway allows writing."),
    reason: z.string().describe("Why the source is not writable; absent when it is.").optional(),
    components: z.array(ComponentParametersSchema).describe("Every parameter FB of the source's config manifest."),
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

export const ClientMessageSchema = z
  .discriminatedUnion("kind", [WriteParametersCommandSchema, ResetParametersCommandSchema])
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
    stageId: int("Stage id of the write; `handledStageId` in `parameters` names it once the PLC handled it.").optional(),
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
    ParametersMessageSchema,
    WriteResultMessageSchema,
  ])
  .describe("Every message the gateway sends on the WebSocket, one JSON object per WebSocket text message.");
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
