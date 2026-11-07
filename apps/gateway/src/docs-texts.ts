import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Markdown file of `docs/` the documentation page shows: the guide to the PLC library for PLC programmers. */
export const GUIDE_FILE = "plc-library-guide.md";
/** Folder of `docs/` with the guide's diagrams (SVG). */
export const IMAGES_DIR = "images";

/** What the package bundle embeds (`scripts/package.mjs`): the guide and every file of `docs/images`. */
declare const __RPP_DOCS__: { guide: string; images: Record<string, string> } | undefined;

const docsDir = () => join(dirname(fileURLToPath(import.meta.url)), "../../../docs");

/**
 * The guide's Markdown. The package bundle embeds it at build time, so the installed gateway needs no docs folder;
 * run from the repo it is read from `docs/`, so an edit shows after a restart.
 */
export function guideText(): string {
  if (typeof __RPP_DOCS__ === "object") return __RPP_DOCS__.guide;
  return readFileSync(join(docsDir(), GUIDE_FILE), "utf8");
}

/** A diagram the guide links as `images/<name>`, by that name; undefined if there is none. */
export function docImage(name: string): string | undefined {
  if (typeof __RPP_DOCS__ === "object") return __RPP_DOCS__.images[name];
  const path = join(docsDir(), IMAGES_DIR, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
