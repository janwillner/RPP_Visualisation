import { Marked, type Tokens } from "marked";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import {
  ClientMessageSchema,
  ConfigMessageSchema,
  GatewayMessageSchema,
  ParametersMessageSchema,
  ServerMessageSchema,
  WriteResultMessageSchema,
  HealthReportSchema,
  MachineReportSchema,
  PROTOCOL_VERSION,
  RecordingEntrySchema,
  RecordingFileHeaderSchema,
  StateMessageSchema,
  StatusMessageSchema,
  type HealthReport,
} from "@rpp/protocol";
import { STATUS } from "@rpp/machine-view/palette";
import { docImage, guideText, IMAGES_DIR } from "./docs-texts";

/**
 * The documentation the gateway serves at `/docs` (ADR 0014): for PLC programmers, the guide to the PLC library
 * `Syn_Visu` of the version this gateway runs, with its diagrams, as one self-contained HTML page (no CDN, the IPCs
 * are offline). `/docs/schema.json` stays for programs that read the gateway: the JSON Schema of its messages.
 */

/** Where the documentation lives on the server. */
export const DOCS_PATH = "/docs";
export const DOCS_SCHEMA_PATH = "/docs/schema.json";

/** JSON Schema (draft-07) of one zod schema, everything inlined, unknown properties allowed (clients ignore them). */
function jsonSchemaOf(schema: ZodTypeAny): JsonSchema {
  const json = zodToJsonSchema(schema, { $refStrategy: "none", removeAdditionalStrategy: "strict" }) as JsonSchema;
  delete json.$schema;
  return json;
}

/** The schemas `/docs/schema.json` covers, by definition name. */
const DEFINITIONS = {
  ServerMessage: ServerMessageSchema,
  GatewayMessage: GatewayMessageSchema,
  StatusMessage: StatusMessageSchema,
  ConfigMessage: ConfigMessageSchema,
  StateMessage: StateMessageSchema,
  MachineReport: MachineReportSchema,
  ParametersMessage: ParametersMessageSchema,
  WriteResultMessage: WriteResultMessageSchema,
  ClientMessage: ClientMessageSchema,
  HealthReport: HealthReportSchema,
  RecordingFileHeader: RecordingFileHeaderSchema,
  RecordingEntry: RecordingEntrySchema,
} as const;
export type DefinitionName = keyof typeof DEFINITIONS;

/**
 * JSON Schema of every message and file, served at `/docs/schema.json`. The root validates one WebSocket message;
 * `definitions` hold each message alone, the `/health` report and the recording file's lines.
 */
export function protocolJsonSchema(): JsonSchema {
  const definitions = Object.fromEntries(
    Object.entries(DEFINITIONS).map(([name, schema]) => [name, jsonSchemaOf(schema)]),
  ) as Record<DefinitionName, JsonSchema>;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `urn:rpp-visualisation:protocol:${PROTOCOL_VERSION}`,
    title: `RPP visualisation protocol, version ${PROTOCOL_VERSION}`,
    description:
      "The root validates one message the gateway sends on the WebSocket /ws. definitions: each message alone " +
      "(GatewayMessage: the ones a recording holds), the commands a client may send (ClientMessage, ADR 0017), the " +
      "/health report (HealthReport) and the lines of a recording file (RecordingFileHeader, then RecordingEntry).",
    $ref: "#/definitions/ServerMessage",
    definitions,
  };
}

/** The subset of JSON Schema that zod-to-json-schema produces for the protocol. */
export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  pattern?: string;
  minLength?: number;
  definitions?: Record<string, JsonSchema>;
}

/** The served documentation: the page is built once on first use, the versions are filled in per request. */
export interface DocsPage {
  /** The HTML page; the versions of the connected PLC libraries come from the live health report. */
  page(health: HealthReport): string;
  /** `/docs/schema.json`. */
  schema(): JsonSchema;
}

export function createDocsPage(version: string): DocsPage {
  let body: PageBody | undefined;
  let schema: JsonSchema | undefined;
  return {
    page(health) {
      return page((body ??= guideBody()), version, health);
    },
    schema() {
      return (schema ??= protocolJsonSchema());
    },
  };
}

interface PageBody {
  title: string;
  toc: TocEntry[];
  content: string;
}

interface TocEntry {
  id: string;
  title: string;
  level: 1 | 2;
}

type InlineParser = { parser: { parseInline(tokens: Tokens.Generic[]): string } };

/**
 * The guide as HTML. Headings get GitHub's anchors, so the guide's own links work on the page as on GitHub; its
 * sections (`##`) and subsections (`###`) make the table of contents. A paragraph that is only a diagram
 * (`![alt](images/x.svg "caption")`) becomes a figure with the SVG inlined. Links to files the server does not show
 * keep only their text.
 */
export function guideBody(): PageBody {
  const toc: TocEntry[] = [];
  const used = new Set<string>();
  let title = "";
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(this: InlineParser, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth === 1) {
          title = plain(inner);
          return `<h1>${inner}</h1>\n`;
        }
        const base = slug(token.text);
        let id = base;
        for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        if (token.depth <= 3) toc.push({ id, title: plain(inner), level: token.depth === 2 ? 1 : 2 });
        return `<h${token.depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${token.depth}>\n`;
      },
      link(this: InlineParser, token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const external = /^[a-z]+:/i.test(token.href);
        return external || token.href.startsWith("#") ? `<a href="${escapeHtml(token.href)}">${inner}</a>` : inner;
      },
      paragraph(this: InlineParser, token: Tokens.Paragraph) {
        const content = token.tokens.filter((t) => !(t.type === "text" && t.raw.trim() === ""));
        const image = content.length === 1 && content[0]!.type === "image" ? (content[0] as Tokens.Image) : undefined;
        if (image) return figure(image);
        return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
      },
      image(token: Tokens.Image) {
        return diagram(token);
      },
    },
  });
  const content = marked.parse(guideText(), { async: false });
  return { title, toc, content: `<article class="doc">${content}</article>` };
}

/** A diagram with its caption (the image's title, else its alt text). */
function figure(image: Tokens.Image): string {
  const caption = image.title || image.text;
  return `<figure class="diagram">${diagram(image)}<figcaption>${escapeHtml(caption)}</figcaption></figure>\n`;
}

/**
 * The SVG of a diagram in `docs/images`, inlined: its ids get the file's name as a prefix, so the arrow markers of
 * one diagram do not take another's. A missing diagram is an error, so a broken link fails the tests.
 */
function diagram(image: Tokens.Image): string {
  const name = image.href.startsWith(`${IMAGES_DIR}/`) ? image.href.slice(IMAGES_DIR.length + 1) : undefined;
  const svg = name ? docImage(name) : undefined;
  if (!name || svg === undefined) throw new Error(`The guide shows a diagram that does not exist: ${image.href}`);
  const prefix = slug(name.replace(/\.svg$/, ""));
  return svg
    .replace(/<\?xml[^>]*\?>\s*/, "")
    .replace(/\bid="([^"]+)"/g, `id="${prefix}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`)
    .replace(/<svg\b/, `<svg aria-label="${escapeHtml(image.text)}"`)
    .trim();
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function page(body: PageBody, version: string, health: HealthReport): string {
  const libraries = health.sources
    .filter((s) => s.libraryVersion)
    .map((s) => `${escapeHtml(s.libraryVersion!)} <span class="muted">(${escapeHtml(s.name)})</span>`);
  const toc = body.toc
    .map((e) => `<li class="l${e.level}"><a href="#${e.id}">${escapeHtml(e.title)}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DOCS_TITLE}</title>
<style>${CSS}</style>
</head>
<body>
<nav class="toc">
<div class="brand"><a href="#top">${DOCS_TITLE}</a></div>
<ul>${toc}</ul>
<div class="back"><a href="/">← Back to the visualisation</a></div>
</nav>
<main id="top">
<dl class="versions">
<div><dt>Protocol version of this gateway</dt><dd>${PROTOCOL_VERSION}</dd></div>
<div><dt>Gateway release</dt><dd>${escapeHtml(version)}</dd></div>
<div><dt>Syn_Visu on the connected PLCs</dt><dd>${libraries.length ? libraries.join(", ") : `<span class="muted">no PLC reports it right now</span>`}</dd></div>
</dl>
${body.content}
</main>
</body>
</html>`;
}

/** The page's title, also the link text in the web app's status bar points here. */
export const DOCS_TITLE = "Syn_Visu PLC library guide";

/** Text of an HTML fragment, for the table of contents. */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Dark like the app (its panel colours and accent from the palette), light when the system asks for it. */
const CSS = `
:root {
  color-scheme: light dark;
  --bg: #15181d; --panel: #1f242c; --border: #2f3640; --text: #dfe5ec; --muted: #8893a2;
  --accent: ${STATUS.accent}; --code-bg: #252b34;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.55;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff; --panel: #f4f6f9; --border: #d9dee5; --text: #1d232b; --muted: #5d6875;
    --accent: #0b6fa4; --code-bg: #eef1f5;
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 16px; }
body { margin: 0; background: var(--bg); color: var(--text); display: flex; min-height: 100vh; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.toc { position: sticky; top: 0; height: 100vh; overflow-y: auto; width: 300px; flex: none; padding: 20px 16px;
  background: var(--panel); border-right: 1px solid var(--border); font-size: 14px; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 2px 0; }
.toc li.l1 { margin-top: 10px; font-weight: 600; }
.toc li.l2 { padding-left: 12px; font-size: 13px; }
.toc li a { color: var(--text); }
.toc li.l2 a { color: var(--muted); }
.toc li a:hover { color: var(--accent); }
.brand { font-weight: 700; font-size: 16px; margin-bottom: 8px; }
.brand a { color: var(--text); }
.back { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--border); }
main { flex: 1; min-width: 0; max-width: 1020px; padding: 24px 40px 80px; }
.versions { display: flex; flex-wrap: wrap; gap: 8px 32px; margin: 0 0 8px; padding: 12px 16px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 6px; }
.versions dt { font-size: 12px; color: var(--muted); }
.versions dd { margin: 0; font-weight: 600; }
.muted { color: var(--muted); font-weight: 400; }
h1 { font-size: 30px; line-height: 1.25; margin: 28px 0 12px; }
h2 { font-size: 24px; margin: 48px 0 12px; padding-top: 16px; border-top: 1px solid var(--border); }
h3 { font-size: 19px; margin: 32px 0 8px; }
h4 { font-size: 16px; margin: 24px 0 8px; }
h2 a.anchor, h3 a.anchor, h4 a.anchor, h5 a.anchor, h6 a.anchor { color: inherit; }
code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.9em; background: var(--code-bg);
  padding: 1px 4px; border-radius: 4px; font-variant-ligatures: none; }
pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto;
  font-size: 13px; line-height: 1.45; tab-size: 4; }
pre code { background: none; padding: 0; font-size: inherit; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--panel); }
blockquote { margin: 12px 0; padding: 4px 16px; border-left: 3px solid var(--accent); color: var(--muted); }
figure.diagram { margin: 20px 0; padding: 16px; background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; }
figure.diagram svg { display: block; width: 100%; height: auto; margin: 0 auto; }
figure.diagram figcaption { margin-top: 10px; font-size: 13px; color: var(--muted); text-align: center; }
@media (max-width: 800px) {
  body { display: block; }
  .toc { position: static; width: auto; height: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  main { padding: 16px; }
  figure.diagram { padding: 8px; overflow-x: auto; }
  figure.diagram svg { min-width: 640px; }
}
`;
