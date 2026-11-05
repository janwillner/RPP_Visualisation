import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Markdown files of `docs/` the API documentation shows, in page order. */
export const DOC_FILES = ["api.md", "plc-contract.md", "plc-library-guide.md"] as const;
export type DocFile = (typeof DOC_FILES)[number];

declare const __RPP_DOCS__: Record<DocFile, string> | undefined;

/**
 * A Markdown file of `docs/`. The package bundle embeds them at build time (`scripts/package.mjs`), so the installed
 * gateway needs no docs folder; run from the repo they are read from `docs/`, so an edit shows after a restart.
 */
export function docText(file: DocFile): string {
  if (typeof __RPP_DOCS__ === "object") return __RPP_DOCS__[file];
  const docs = join(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  return readFileSync(join(docs, file), "utf8");
}
