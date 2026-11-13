import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  COMPONENT_SCHEMAS,
  GatewayMessageSchema,
  HealthReportSchema,
  PROTOCOL_VERSION,
  type ConfigMessage,
  type MachineReport,
  type GatewayMessage,
  type StateMessage,
  type StatusMessage,
} from "@rpp/protocol";
import { DOCS_TITLE, guideBody, protocolJsonSchema, type JsonSchema } from "../src/docs-page";
import { guideText } from "../src/docs-texts";
import { combineGateways, createGateway } from "../src/gateway";
import { watchHealth } from "../src/health";
import { DOCS_PATH, DOCS_SCHEMA_PATH, startServer } from "../src/server";
import { fixtureMachine, FIXTURE_SOURCE } from "./fixture-machine";

/** Every property below `schema` without a description, as paths. */
function undescribed(schema: JsonSchema, path: string): string[] {
  const missing: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const at = `${path}.${name}`;
    if (!prop.description) missing.push(at);
    missing.push(...undescribed(prop, at));
  }
  for (const [i, variant] of (schema.anyOf ?? schema.oneOf ?? []).entries()) missing.push(...undescribed(variant, `${path}|${i}`));
  if (schema.items) missing.push(...undescribed(schema.items, `${path}[]`));
  if (typeof schema.additionalProperties === "object") missing.push(...undescribed(schema.additionalProperties, `${path}{}`));
  return missing;
}

/** Every `id` and every in-page link target of an HTML page. */
function anchors(html: string): { ids: string[]; targets: string[] } {
  return {
    ids: [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!),
    targets: [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!),
  };
}

describe("PLC library guide at /docs", () => {
  it("shows every diagram of the guide inline, with ids of its own", () => {
    const linked = [...guideText().matchAll(/!\[[^\]]*\]\((images\/[^ )]+)/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThanOrEqual(14);

    const { title, content, toc } = guideBody();
    expect(title).toContain("Syn_Visu");
    expect(content.match(/<figure class="diagram"><svg /g)).toHaveLength(linked.length);
    expect(content).not.toContain("<img");
    // Each diagram's arrow markers are its own: ids are unique on the page and every url(#…) finds one.
    const { ids } = anchors(content);
    expect(ids.length).toBe(new Set(ids).size);
    for (const [, ref] of content.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(ref);
    // Sections and subsections make the table of contents, with GitHub's anchors.
    expect(toc.map((e) => e.id)).toEqual(expect.arrayContaining(["1-how-it-works", "5-conveyors-and-products", "19-reference", "193-enumerations"]));
  });

  it("links only to anchors on the page", () => {
    const { content } = guideBody();
    const { ids, targets } = anchors(content);
    expect(targets.filter((t) => !ids.includes(t))).toEqual([]);
  });

  it("describes every field of every message, of /health and of the recording file in /docs/schema.json", () => {
    const { definitions } = protocolJsonSchema();
    const missing = Object.entries(definitions!).flatMap(([name, schema]) => undescribed(schema, name));
    expect(missing).toEqual([]);
  });

  it("gives a JSON Schema that the messages of a machine with every component type and the health report pass", async () => {
    const schema = protocolJsonSchema();
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(schema);
    const validate = (ref: string, value: unknown) => {
      const check = ajv.getSchema(`${schema.$id}${ref}`)!;
      expect(check(value), `${ref}: ${ajv.errorsText(check.errors)}`).toBe(true);
    };

    const machine = fixtureMachine();
    const gateway = createGateway({ plc: machine.plc, sourceId: FIXTURE_SOURCE, sourceName: "Fixture" });
    const health = watchHealth(gateway, "1.2.3");
    const last: { status?: StatusMessage; config?: ConfigMessage; state?: StateMessage; machine?: MachineReport } = {};
    gateway.subscribe((m) => {
      if (m.kind !== "parameters") last[m.kind] = m as never;
    });
    for (let i = 0; i < 10; i++) {
      machine.step();
      await gateway.cycle();
    }
    // Discovered as a whole, with every component type.
    expect(last.config!.errors).toEqual([]);
    expect(new Set(last.config!.components.map((c) => c.type)).size).toBe(Object.keys(COMPONENT_SCHEMAS).length);
    for (const message of [last.status!, last.config!, last.state!, last.machine!]) {
      validate("", message);
      const definition = message.kind === "machine" ? "MachineReport" : `${message.kind[0]!.toUpperCase()}${message.kind.slice(1)}Message`;
      validate(`#/definitions/${definition}`, message);
      expect(GatewayMessageSchema.parse(message)).toEqual(message);
    }
    validate("#/definitions/HealthReport", health());
    HealthReportSchema.parse(health());
  }, 30_000);

  it("lets clients ignore fields they do not know: the schema allows extra properties", () => {
    const schema = protocolJsonSchema();
    const ajv = new Ajv();
    const message = { kind: "status", sourceId: FIXTURE_SOURCE, sourceName: "Fixture", status: { plcConnected: true }, extra: 1 };
    expect(ajv.validate(schema, message)).toBe(true);
  });

  it("is served at /docs and /docs/schema.json, without a web app and in front of the web app's fallback", async () => {
    const web = mkdtempSync(join(tmpdir(), "rpp-web-"));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>web app</title>");
    for (const staticDir of [undefined, web]) {
      const machine = fixtureMachine();
      const gateway = createGateway({ plc: machine.plc, sourceId: FIXTURE_SOURCE, sourceName: "Fixture" });
      await gateway.cycle();
      const server = await startServer({
        gateway: combineGateways([gateway]),
        port: 0,
        host: "127.0.0.1",
        version: "1.2.3",
        ...(staticDir ? { staticDir } : {}),
      });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        for (const path of [DOCS_PATH, `${DOCS_PATH}/`]) {
          const page = await fetch(`${base}${path}`);
          expect(page.status).toBe(200);
          expect(page.headers.get("content-type")).toContain("text/html");
          const html = await page.text();
          expect(html).toContain(`<title>${DOCS_TITLE}</title>`);
          for (const id of ["1-how-it-works", "2-setting-up-the-project", "19-reference"]) expect(html).toContain(`id="${id}"`);
          expect(html).toContain('<figure class="diagram">');
          expect(html).toContain("1.2.3");
          expect(html).toContain(`<dd>${PROTOCOL_VERSION}</dd>`);
          // Only for PLC programmers: no WebSocket reference any more.
          expect(html).not.toContain('id="ref-state"');
        }

        const schema = await fetch(`${base}${DOCS_SCHEMA_PATH}`);
        expect(schema.status).toBe(200);
        expect(schema.headers.get("content-type")).toContain("application/json");
        expect(await schema.json()).toEqual(JSON.parse(JSON.stringify(protocolJsonSchema())));

        if (staticDir) expect(await (await fetch(`${base}/somewhere`)).text()).toContain("web app");
      } finally {
        server.close();
      }
    }
  }, 30_000);
});
