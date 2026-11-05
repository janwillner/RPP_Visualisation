import { z } from "zod";

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
