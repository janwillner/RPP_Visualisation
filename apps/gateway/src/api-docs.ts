import { Marked, type Tokens } from "marked";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import {
  ConfigMessageSchema,
  GatewayMessageSchema,
  HealthReportSchema,
  PROTOCOL_VERSION,
  RECORDING_FILE_FORMAT,
  RECORDING_FILE_FORMAT_VERSION,
  RecordingEntrySchema,
  RecordingFileHeaderSchema,
  StateMessageSchema,
  StatusMessageSchema,
  type ConfigMessage,
  type GatewayMessage,
  type HealthReport,
  type RecordingEntry,
  type RecordingFileHeader,
  type StateMessage,
  type StatusMessage,
} from "@rpp/protocol";
import { STATUS } from "../../web/src/palette";
import { DOC_FILES, docText, type DocFile } from "./docs-texts";
import { createGateway } from "./gateway";
import { watchHealth } from "./health";
import { OPTION_HELP } from "./options";
import { createSimulator } from "./simulator";

/**
 * The API documentation the gateway serves at `/docs` (ADR 0012): one self-contained HTML page (no CDN, the IPCs are
 * offline) with the introduction from `docs/api.md`, a reference generated from the protocol's zod schemas with real
 * examples from the simulator, the server options from `--help`, and the PLC contract and library guide. The JSON
 * Schema of everything is served at `/docs/schema.json`.
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

/** The schemas the documentation covers, by definition name. */
const DEFINITIONS = {
  GatewayMessage: GatewayMessageSchema,
  StatusMessage: StatusMessageSchema,
  ConfigMessage: ConfigMessageSchema,
  StateMessage: StateMessageSchema,
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
      "The root validates one message of the WebSocket /ws. definitions: each message alone, the /health report " +
      "(HealthReport) and the lines of a recording file (RecordingFileHeader, then RecordingEntry).",
    $ref: "#/definitions/GatewayMessage",
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

/** Real messages from the simulator, shortened, plus the `/health` report and recording file lines built from them. */
export interface ApiExamples {
  status: StatusMessage;
  config: ConfigMessage;
  state: StateMessage;
  health: HealthReport;
  recordingHeader: RecordingFileHeader;
  recordingEntry: RecordingEntry;
}

/** Fixed wall-clock time of the examples, so they do not change from one start to the next. */
const EXAMPLE_TIME = Date.UTC(2026, 0, 1, 12, 0, 0);
/** Simulated time before the examples are taken: long enough for products in every state. */
const EXAMPLE_CYCLES = 600;
const EXAMPLE_CYCLE_MS = 20;
/** Entries kept of every list inside a component, so an example stays readable. */
const EXAMPLE_LIST_LENGTH = 2;

/** Runs the simulator through a real gateway and takes its messages as examples. */
export async function apiExamples(version: string): Promise<ApiExamples> {
  const sim = createSimulator({ seed: 1 });
  const gateway = createGateway({ plc: sim.plc, sourceId: "sim", sourceName: "Simulator" });
  const health = watchHealth(gateway, version, () => EXAMPLE_TIME);
  let status: StatusMessage | undefined;
  let config: ConfigMessage | undefined;
  let state: StateMessage | undefined;
  gateway.subscribe((m: GatewayMessage) => {
    if (m.kind === "status") status = m;
    else if (m.kind === "config") config = m;
    else state = m;
  });
  for (let i = 0; i < EXAMPLE_CYCLES; i++) {
    sim.step(EXAMPLE_CYCLE_MS);
    await gateway.cycle();
  }
  if (!status || !config || !state) throw new Error("The simulator produced no examples");

  // One component of every type, each list in it cut short; the state shows the same components.
  const types = new Set<string>();
  const components = config.components.filter((c) => !types.has(c.type) && types.add(c.type));
  const ids = new Set(components.map((c) => c.id));
  const shortConfig: ConfigMessage = { ...config, components: components.map((c) => shorten(c)) };
  const shortState: StateMessage = {
    ...state,
    components: state.components.filter((c) => ids.has(c.id)).map((c) => shorten(c)),
  };
  const registers = Object.fromEntries(
    shortState.components.flatMap((c) => (c.type === "conveyor" ? [[String(c.id), c.products.map((p) => p.id)]] : [])),
  );
  return {
    status,
    config: shortConfig,
    state: shortState,
    health: health(),
    recordingHeader: {
      format: RECORDING_FILE_FORMAT,
      formatVersion: RECORDING_FILE_FORMAT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      recordedAt: new Date(EXAMPLE_TIME).toISOString(),
      durationMs: 60_000,
      sources: [{ sourceId: status.sourceId, name: status.sourceName, status: status.status, config: shortConfig }],
    },
    recordingEntry: { at: 1520, message: shortState, registers },
  };
}

/** Lists kept whole: products refer to any of the product types. */
const KEPT_WHOLE = new Set(["productTypes"]);

/** Cuts every list below the top level to EXAMPLE_LIST_LENGTH entries; lists in config and state are cut alike. */
function shorten<T>(value: T, key = ""): T {
  if (Array.isArray(value)) {
    const kept = KEPT_WHOLE.has(key) ? value : value.slice(0, EXAMPLE_LIST_LENGTH);
    return kept.map((v) => shorten(v)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v, k)])) as T;
  }
  return value;
}

/** Served API documentation: built once on first use, since the examples take a simulator run. */
export interface ApiDocs {
  /** The HTML page; the versions of the connected PLC libraries come from the live health report. */
  page(health: HealthReport): Promise<string>;
  /** `/docs/schema.json`. */
  schema(): JsonSchema;
}

export function createApiDocs(version: string): ApiDocs {
  let body: Promise<PageBody> | undefined;
  let schema: JsonSchema | undefined;
  return {
    async page(health) {
      body ??= buildBody(version);
      // A failed build is tried again on the next request.
      const built = await body.catch((error: unknown) => {
        body = undefined;
        throw error;
      });
      return page(built, version, health);
    },
    schema() {
      return (schema ??= protocolJsonSchema());
    },
  };
}

interface PageBody {
  toc: TocEntry[];
  content: string;
}

interface TocEntry {
  id: string;
  title: string;
  level: 1 | 2;
}

/** Ids the Markdown documents' headings get: a prefix per document, then the heading's GitHub slug. */
const DOC_PREFIX: Record<DocFile, string> = {
  "api.md": "api",
  "plc-contract.md": "plc-contract",
  "plc-library-guide.md": "plc-guide",
};

async function buildBody(version: string): Promise<PageBody> {
  const examples = await apiExamples(version);
  const toc: TocEntry[] = [];
  const parts: string[] = [];

  const intro = markdown("api.md");
  toc.push(...intro.toc);
  parts.push(intro.html);

  toc.push({ id: "reference", title: "Reference", level: 1 });
  parts.push(reference(examples, toc));

  toc.push({ id: "server-options", title: "Server options", level: 1 });
  parts.push(serverOptions());

  for (const file of ["plc-contract.md", "plc-library-guide.md"] as const) {
    const doc = markdown(file);
    toc.push(...doc.toc);
    parts.push(doc.html);
  }
  return { toc, content: parts.join("\n") };
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

/**
 * Renders one document of `docs/` one heading level down (its title becomes a section of the page). Anchors within
 * it and links to the other shown documents become links within the page; links to files that are not shown keep
 * only their text, since the server has nothing to show there.
 */
function markdown(file: DocFile): { html: string; toc: TocEntry[] } {
  const prefix = DOC_PREFIX[file];
  const toc: TocEntry[] = [];
  const used = new Set<string>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        let id = token.depth === 1 ? prefix : `${prefix}-${slug(token.text)}`;
        for (let n = 1; used.has(id); n++) id = `${prefix}-${slug(token.text)}-${n}`;
        used.add(id);
        if (token.depth <= 2) toc.push({ id, title: plain(inner), level: token.depth === 1 ? 1 : 2 });
        const level = Math.min(token.depth + 1, 6);
        return `<h${level} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${level}>\n`;
      },
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const href = pageLink(token.href, prefix);
        return href === undefined ? inner : `<a href="${escapeHtml(href)}">${inner}</a>`;
      },
    },
  });
  return { html: `<section class="doc">${marked.parse(docText(file), { async: false })}</section>`, toc };
}

/** Where a link in a shown document points on the page; undefined for a file the server does not show. */
function pageLink(href: string, prefix: string): string | undefined {
  if (/^[a-z]+:/i.test(href)) return href;
  if (href.startsWith("#")) return `#${prefix}-${href.slice(1)}`;
  const [path = "", fragment] = href.split("#");
  const file = DOC_FILES.find((f) => path === f || path.endsWith(`/${f}`));
  if (!file) return undefined;
  return fragment ? `#${DOC_PREFIX[file]}-${fragment}` : `#${DOC_PREFIX[file]}`;
}

const inlineMarked = new Marked({ gfm: true });

/** A schema description (Markdown inline: `code`) as HTML. */
function describe(text: string | undefined): string {
  return text ? `<p class="desc">${inlineMarked.parseInline(text, { async: false })}</p>` : "";
}

function reference(examples: ApiExamples, toc: TocEntry[]): string {
  const sub = (id: string, title: string) => {
    toc.push({ id, title: plain(title), level: 2 });
    return `<h3 id="${id}"><a class="anchor" href="#${id}">${title}</a></h3>`;
  };
  const defs = protocolJsonSchema().definitions as Record<DefinitionName, JsonSchema>;
  const message = (name: DefinitionName, id: string, title: string, example: unknown) =>
    `${sub(id, title)}${definition(defs[name], example)}`;
  return `<section class="doc reference">
<h2 id="reference"><a class="anchor" href="#reference">Reference</a></h2>
<p class="desc">Generated from the protocol schemas of this server (protocol version ${PROTOCOL_VERSION}). The examples
are real messages of the built-in simulator, with every list inside a component cut to ${EXAMPLE_LIST_LENGTH} entries.
The same schemas as JSON Schema: <a href="${DOCS_SCHEMA_PATH}"><code>${DOCS_SCHEMA_PATH}</code></a>.</p>
${sub("ref-endpoints", "Endpoints")}
${endpoints()}
${message("StatusMessage", "ref-status", "Message <code>status</code>", examples.status)}
${message("ConfigMessage", "ref-config", "Message <code>config</code>", examples.config)}
${message("StateMessage", "ref-state", "Message <code>state</code>", examples.state)}
${message("HealthReport", "ref-health", "<code>GET /health</code>", examples.health)}
${message("RecordingFileHeader", "ref-recording-header", "Recording file: header line", examples.recordingHeader)}
${message("RecordingEntry", "ref-recording-entry", "Recording file: message lines", examples.recordingEntry)}
</section>`;
}

function endpoints(): string {
  const rows: [string, string][] = [
    ["GET /ws", "WebSocket (upgrade). The server sends every message as one JSON text frame and ignores what the client sends."],
    ["GET /health", "Health of every source as JSON (<code>HealthReport</code>): status 200 while all are connected, else 503."],
    [`GET ${DOCS_PATH}`, "This documentation."],
    [`GET ${DOCS_SCHEMA_PATH}`, "JSON Schema (draft-07) of the messages, the health report and the recording file lines."],
    ["GET /*", "The web app; unknown paths answer with the app's <code>index.html</code>."],
  ];
  return `<table><thead><tr><th>Request</th><th>Answer</th></tr></thead><tbody>${rows
    .map(([req, text]) => `<tr><td><code>${req}</code></td><td>${text}</td></tr>`)
    .join("")}</tbody></table>`;
}

/** One message or file line: its description, its fields as a tree and an example. */
function definition(schema: JsonSchema, example: unknown): string {
  return `${describe(schema.description)}
<div class="schema">${fields(schema)}</div>
<details class="example"><summary>Example</summary><pre><code>${escapeHtml(JSON.stringify(example, null, 2))}</code></pre></details>`;
}

/** The fields of an object schema as a list; nested objects and unions fold out. */
function fields(schema: JsonSchema): string {
  const props = Object.entries(schema.properties ?? {});
  if (props.length === 0) return "";
  const required = new Set(schema.required ?? []);
  return `<ul class="fields">${props
    .map(([name, prop]) => {
      const optional = required.has(name) ? "" : ` <span class="badge">optional</span>`;
      return `<li><div class="field"><code class="name">${escapeHtml(name)}</code> <span class="type">${escapeHtml(
        typeLabel(prop),
      )}</span>${optional}</div>${describe(prop.description)}${children(prop)}</li>`;
    })
    .join("")}</ul>`;
}

/** What a field contains below itself: an object's fields, or a union's variants. */
function children(schema: JsonSchema): string {
  const inner = unwrap(schema);
  const variants = inner.anyOf ?? inner.oneOf;
  if (variants) {
    return variants
      .map(
        (v) =>
          `<details class="variant"><summary><code>${escapeHtml(discriminator(v) ?? typeLabel(v))}</code>${
            v.description ? ` <span class="summary-desc">${plain(inlineMarked.parseInline(v.description, { async: false }))}</span>` : ""
          }</summary>${fields(v)}</details>`,
      )
      .join("");
  }
  if (inner.properties) return `<details><summary>${Object.keys(inner.properties).length} fields</summary>${fields(inner)}</details>`;
  if (typeof inner.additionalProperties === "object" && inner.additionalProperties.properties) {
    return `<details><summary>value fields</summary>${fields(inner.additionalProperties)}</details>`;
  }
  return "";
}

/** The schema inside a nullable wrapper or an array (of nullable entries). */
function unwrap(schema: JsonSchema): JsonSchema {
  if (schema.type === "array" && schema.items) return unwrap(schema.items);
  const variants = schema.anyOf;
  if (variants?.some(isNull)) {
    const rest = variants.filter((v) => !isNull(v));
    return rest.length === 1 ? unwrap(rest[0]!) : { ...schema, anyOf: rest };
  }
  return schema;
}

const isNull = (s: JsonSchema) => s.type === "null";

/** `type = "delta"` for a variant of a union told apart by a constant field. */
function discriminator(variant: JsonSchema): string | undefined {
  for (const [name, prop] of Object.entries(variant.properties ?? {})) {
    if (prop.const !== undefined) return `${name} = ${JSON.stringify(prop.const)}`;
  }
  return undefined;
}

/** A short type label: `number`, `string (pattern)`, `"a" | "b"`, `Zone[]`-like `object[]`, `object | null`. */
export function typeLabel(schema: JsonSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const consts = variants.map(discriminator);
    if (consts.every((c) => c !== undefined)) return "object";
    return variants.map(typeLabel).join(" | ");
  }
  if (schema.type === "array") return schema.items ? `${wrapped(typeLabel(schema.items))}[]` : "array";
  if (schema.type === "object" && !schema.properties && typeof schema.additionalProperties === "object") {
    return `map of ${typeLabel(schema.additionalProperties)}`;
  }
  if (schema.type === "string" && schema.pattern === "^\\d+$") return "string (decimal digits)";
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  return schema.type ?? "any";
}

const wrapped = (label: string) => (label.includes(" ") ? `(${label})` : label);

function serverOptions(): string {
  return `<section class="doc">
<h2 id="server-options"><a class="anchor" href="#server-options">Server options</a></h2>
<p class="desc">The gateway's command-line options, as <code>--help</code> prints them. In a <code>--config</code> JSON file
each is the camelCase key (<code>--ads-port</code> → <code>"adsPort"</code>); flags win over the file. Installation as a
Windows service: see <code>DEPLOYMENT.md</code> in the package.</p>
<table><thead><tr><th>Option</th><th>Meaning</th></tr></thead><tbody>${OPTION_HELP.map(
    ({ flag, text }) =>
      `<tr><td><code>${escapeHtml(flag)}</code></td><td><pre class="plain">${escapeHtml(text.join("\n"))}</pre></td></tr>`,
  ).join("")}</tbody></table>
</section>`;
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
<title>RPP visualisation API</title>
<style>${CSS}</style>
</head>
<body>
<nav class="toc">
<div class="brand"><a href="#api">RPP visualisation API</a></div>
<ul>${toc}</ul>
<div class="back"><a href="/">← Back to the visualisation</a></div>
</nav>
<main>
<dl class="versions">
<div><dt>Protocol version</dt><dd>${PROTOCOL_VERSION}</dd></div>
<div><dt>Release</dt><dd>${escapeHtml(version)}</dd></div>
<div><dt>Syn_Visu library</dt><dd>${libraries.length ? libraries.join(", ") : `<span class="muted">no PLC reports it right now</span>`}</dd></div>
</dl>
${body.content}
</main>
</body>
</html>`;
}

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
  --accent: ${STATUS.accent}; --code-bg: #252b34; --badge: ${STATUS.offline};
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.55;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff; --panel: #f4f6f9; --border: #d9dee5; --text: #1d232b; --muted: #5d6875;
    --accent: #0b6fa4; --code-bg: #eef1f5; --badge: #a35a00;
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 16px; }
body { margin: 0; background: var(--bg); color: var(--text); display: flex; min-height: 100vh; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.toc { position: sticky; top: 0; height: 100vh; overflow-y: auto; width: 290px; flex: none; padding: 20px 16px;
  background: var(--panel); border-right: 1px solid var(--border); font-size: 14px; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 2px 0; }
.toc li.l1 { margin-top: 12px; font-weight: 600; }
.toc li.l2 { padding-left: 12px; }
.toc li a { color: var(--text); }
.toc li.l2 a { color: var(--muted); }
.toc li a:hover { color: var(--accent); }
.brand { font-weight: 700; font-size: 16px; margin-bottom: 8px; }
.brand a { color: var(--text); }
.back { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--border); }
main { flex: 1; min-width: 0; max-width: 980px; padding: 24px 40px 80px; }
.versions { display: flex; flex-wrap: wrap; gap: 8px 32px; margin: 0 0 8px; padding: 12px 16px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 6px; }
.versions dt { font-size: 12px; color: var(--muted); }
.versions dd { margin: 0; font-weight: 600; }
.muted { color: var(--muted); font-weight: 400; }
h2 { font-size: 26px; margin: 48px 0 12px; padding-top: 16px; border-top: 1px solid var(--border); }
h3 { font-size: 20px; margin: 32px 0 8px; }
h4 { font-size: 17px; margin: 24px 0 8px; }
h2 a.anchor, h3 a.anchor, h4 a.anchor, h5 a.anchor, h6 a.anchor { color: inherit; }
code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.9em; background: var(--code-bg);
  padding: 1px 4px; border-radius: 4px; }
pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto;
  font-size: 13px; line-height: 1.45; }
pre code { background: none; padding: 0; font-size: inherit; }
pre.plain { background: none; border: 0; padding: 0; margin: 0; white-space: pre-wrap; font-family: inherit; font-size: inherit; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--panel); }
blockquote { margin: 12px 0; padding: 4px 16px; border-left: 3px solid var(--accent); color: var(--muted); }
.desc { margin: 4px 0; }
ul.fields { list-style: none; margin: 4px 0; padding-left: 0; }
ul.fields ul.fields { padding-left: 18px; border-left: 1px solid var(--border); }
ul.fields > li { padding: 6px 0; border-bottom: 1px dashed var(--border); }
ul.fields > li:last-child { border-bottom: 0; }
.field .name { font-weight: 600; }
.field .type { color: var(--muted); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.85em; }
.badge { font-size: 11px; color: var(--badge); border: 1px solid var(--badge); border-radius: 8px; padding: 0 6px; }
details { margin: 4px 0; }
summary { cursor: pointer; color: var(--accent); }
.summary-desc { color: var(--muted); }
details.example { margin-top: 12px; }
details.example > summary { font-weight: 600; }
@media (max-width: 800px) {
  body { display: block; }
  .toc { position: static; width: auto; height: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  main { padding: 16px; }
}
`;
