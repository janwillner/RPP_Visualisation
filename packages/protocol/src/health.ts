import { z } from "zod";

/** Average and maximum of a measured value over the recent snapshots. */
const spread = (description: string) =>
  z
    .object({
      avg: z.number().describe("Average over the window."),
      max: z.number().describe("Largest value in the window."),
    })
    .describe(description);

/**
 * How reading one source performs, for diagnosing large machines: timings and sizes over the most recent snapshots,
 * and checks of the conveyors' product registers.
 */
export const AcquisitionStatsSchema = z
  .object({
    window: z
      .number()
      .int()
      .describe("Number of state snapshots the averages and maxima cover: the most recent ones, up to 250."),
    readMs: spread(
      "Time to read every component state of the source in one sum-read, ms: the PLC access including the ADS bridge.",
    ),
    mapMs: spread("Time to map the states read to the neutral model, ms."),
    stateBytes: spread("Size of a state message as sent to the browsers, bytes (JSON).")
      .optional()
      .describe(
        "Size of a state message as sent to the browsers, bytes (JSON): in register form (only changed products) " +
          "while a client asked for changes; absent while no browser is connected.",
      ),
    products: z.number().int().describe("Products in all conveyor registers of the newest snapshot."),
    duplicateProducts: z
      .number()
      .int()
      .describe(
        "Since the gateway started: register entries whose product id appeared a second time in the same snapshot. " +
          "Nonzero hints at a register read while the PLC was rearranging it.",
      ),
    flickeringProducts: z
      .number()
      .int()
      .describe(
        "Since the gateway started: products missing from exactly one snapshot and back in the next. Nonzero hints " +
          "at a register read while the PLC was rearranging it.",
      ),
    lastAnomaly: z
      .string()
      .describe("The most recent duplicate or flickering product, in words; absent while there was none.")
      .optional(),
  })
  .describe("How reading this source performs: timings, sizes and register checks.");
export type AcquisitionStats = z.infer<typeof AcquisitionStatsSchema>;

/** Health of one source as `GET /health` reports it. */
export const SourceHealthSchema = z
  .object({
    sourceId: z.string().describe("The source, as in the WebSocket messages' `sourceId`."),
    name: z.string().describe("Display name of the source."),
    plcConnected: z.boolean().describe("The gateway currently reads this PLC."),
    lastError: z.string().describe("Why the last attempt to read the PLC failed; absent when none failed.").optional(),
    lastStateAt: z
      .string()
      .describe("Wall-clock time of the newest state snapshot, ISO 8601 (UTC); absent before the first one.")
      .optional(),
    libraryVersion: z
      .string()
      .describe("Version of the Syn_Visu library the PLC runs, once discovered (library 5.1 and newer).")
      .optional(),
    acquisition: AcquisitionStatsSchema.optional().describe(
      "How reading this source performs: timings, sizes and register checks; absent before the first state snapshot.",
    ),
  })
  .describe("How one source (PLC) is doing.");
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

/** The answer of `GET /health`, for monitoring. */
export const HealthReportSchema = z
  .object({
    ok: z.boolean().describe("Every source is connected, and there is at least one. The HTTP status is 200, else 503."),
    version: z.string().describe("Version of this visualisation release, e.g. `1.2.3` or `0.1.0+aa29151`."),
    protocolVersion: z.number().int().describe("Protocol version the gateway speaks."),
    sources: z.array(SourceHealthSchema).describe("Every configured source, in the configured order."),
  })
  .describe("The answer of `GET /health`, for monitoring.");
export type HealthReport = z.infer<typeof HealthReportSchema>;
