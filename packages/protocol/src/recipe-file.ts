import { z } from "zod";
import { RecipeValueSchema } from "./parameters";
import { SourceIdSchema } from "./model";

/**
 * A recipe saved by the Simulator (ADR 0020, 0022): the values of every recipe field per source, grouped as the
 * application groups its fields (by component), as a JSON file. Opened again, it is reconciled with the recipe each
 * PLC declares now: fields are matched by name, unknown ones skipped.
 */

/** Value of the file's `format`. */
export const RECIPE_FILE_FORMAT = "rpp-sim";
/** Version of the file layout; a reader refuses any other. */
export const RECIPE_FILE_FORMAT_VERSION = 1;

export const RecipeFileSourceSchema = z
  .object({
    sourceId: SourceIdSchema,
    sourceName: z.string().describe("Name of the source when the file was saved, for the reader."),
    values: z
      .record(z.record(RecipeValueSchema))
      .describe(
        "The values by group (the manifest id of the field's component as a string, `0` for the whole machine) and " +
          "field name.",
      ),
  })
  .describe("The recipe of one source.");
export type RecipeFileSource = z.infer<typeof RecipeFileSourceSchema>;

export const RecipeFileSchema = z
  .object({
    format: z.literal(RECIPE_FILE_FORMAT).describe(`Always \`${RECIPE_FILE_FORMAT}\`.`),
    formatVersion: z
      .number()
      .int()
      .describe(`Version of the file layout, currently ${RECIPE_FILE_FORMAT_VERSION}; a reader refuses any other.`),
    name: z.string().describe("Name of the recipe; also names the saved file."),
    sources: z.array(RecipeFileSourceSchema).describe("The recipe of every source that declares one."),
  })
  .describe("A recipe saved by the Simulator: the values of the recipe fields of every source.");
export type RecipeFile = z.infer<typeof RecipeFileSchema>;
