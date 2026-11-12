import { z } from "zod";
import { ComponentConfigSchema, PROTOCOL_VERSION } from "./model";

/**
 * A draft of a machine made in the configurator (ADR 0016): the configuration of every component, as the PLC would
 * report it, saved as a JSON file. Offline it is the whole machine; online it is reconciled with the PLCs' manifests
 * by source, id and type.
 */

/** Value of the file's `format`. */
export const DRAFT_FILE_FORMAT = "rpp-draft";
/** Version of the file layout; a reader refuses any other. */
export const DRAFT_FILE_FORMAT_VERSION = 1;

export const DraftSchema = z
  .object({
    format: z.literal(DRAFT_FILE_FORMAT).describe(`Always \`${DRAFT_FILE_FORMAT}\`.`),
    formatVersion: z
      .number()
      .int()
      .describe(`Version of the file layout, currently ${DRAFT_FILE_FORMAT_VERSION}; a reader refuses any other.`),
    protocolVersion: z
      .number()
      .int()
      .describe(`Protocol version of the component configurations, currently ${PROTOCOL_VERSION}.`),
    name: z.string().describe("Name of the machine; also names the saved file."),
    components: z
      .array(ComponentConfigSchema)
      .describe("Every component of the machine; `sourceId` says which PLC it belongs to, `id` its manifest id there."),
  })
  .describe("A draft of a machine made in the configurator: every component's configuration.");
export type Draft = z.infer<typeof DraftSchema>;

/** A draft with no components. */
export function emptyDraft(name = "Machine"): Draft {
  return {
    format: DRAFT_FILE_FORMAT,
    formatVersion: DRAFT_FILE_FORMAT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    name,
    components: [],
  };
}
