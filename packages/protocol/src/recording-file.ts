import { z } from "zod";
import { ConfigMessageSchema, GatewayMessageSchema, GatewayStatusSchema } from "./model";

/**
 * The file a recording is saved to from the web app (ADR 0006): gzip-compressed text, one JSON object per line. The
 * first line is the header, every other line one gateway message with its arrival time.
 */

/** Value of the header's `format`. */
export const RECORDING_FILE_FORMAT = "rpp-recording";
/** Version of the file layout; a reader refuses any other. */
export const RECORDING_FILE_FORMAT_VERSION = 1;

/** A source as it was when the recording started. */
export const RecordingSourceSchema = z
  .object({
    sourceId: z.string().describe("The source, as in the messages' `sourceId`."),
    name: z.string().describe("Display name of the source."),
    status: GatewayStatusSchema.describe("The source's last status; absent while the WebSocket was down.").optional(),
    config: ConfigMessageSchema.describe("The source's last config; absent before the first one.").optional(),
  })
  .describe("A source as it was when the recording started.");
export type RecordingSource = z.infer<typeof RecordingSourceSchema>;

export const RecordingFileHeaderSchema = z
  .object({
    format: z.literal(RECORDING_FILE_FORMAT).describe(`Always \`${RECORDING_FILE_FORMAT}\`.`),
    formatVersion: z
      .number()
      .int()
      .describe(`Version of the file layout, currently ${RECORDING_FILE_FORMAT_VERSION}; a reader refuses any other.`),
    protocolVersion: z
      .number()
      .int()
      .describe("Protocol version of the recorded messages; the web app plays only its own."),
    recordedAt: z.string().describe("Wall-clock time the recording started, ISO 8601 (UTC)."),
    durationMs: z.number().describe("Length of the recording, ms."),
    sources: z.array(RecordingSourceSchema).describe("Every source as it was when the recording started."),
  })
  .describe("The first line of a recording file.");
export type RecordingFileHeader = z.infer<typeof RecordingFileHeaderSchema>;

export const RecordingEntrySchema = z
  .object({
    at: z.number().describe("Arrival time of the message, ms after the recording started."),
    message: GatewayMessageSchema.describe(
      "The gateway message. In a `state`, each conveyor's `products` hold only the products that changed since that " +
        "conveyor's previous state in the file; `registers` gives the whole register.",
    ),
    registers: z
      .record(z.array(z.number().int()))
      .describe(
        "`state` entries only: per conveyor id the ids of its whole product register, in order. A product not " +
          "listed in `message` is unchanged from the conveyor's previous state.",
      )
      .optional(),
  })
  .describe("Every line after the header: one gateway message with its arrival time.");
export type RecordingEntry = z.infer<typeof RecordingEntrySchema>;
