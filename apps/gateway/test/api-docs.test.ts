import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  GatewayMessageSchema,
  HealthReportSchema,
  PROTOCOL_VERSION,
  RecordingEntrySchema,
  RecordingFileHeaderSchema,
} from "@rpp/protocol";
import { apiExamples, protocolJsonSchema, type JsonSchema } from "../src/api-docs";
import { combineGateways, createGateway } from "../src/gateway";
import { DOCS_PATH, DOCS_SCHEMA_PATH, startServer } from "../src/server";
import { createSimulator } from "../src/simulator";

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

describe("API documentation", () => {
  it("describes every field of every message, of /health and of the recording file", () => {
    const { definitions } = protocolJsonSchema();
    const missing = Object.entries(definitions!).flatMap(([name, schema]) => undescribed(schema, name));
    expect(missing).toEqual([]);
  });

  it("gives a JSON Schema the simulator's examples pass, and they pass the protocol's own schemas too", async () => {
    const schema = protocolJsonSchema();
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(schema);
    const validate = (ref: string, value: unknown) => {
      const check = ajv.getSchema(`${schema.$id}${ref}`)!;
      expect(check(value), `${ref}: ${ajv.errorsText(check.errors)}`).toBe(true);
    };

    const examples = await apiExamples("1.2.3");
    for (const message of [examples.status, examples.config, examples.state]) {
      validate("", message);
      validate(`#/definitions/${message.kind[0]!.toUpperCase()}${message.kind.slice(1)}Message`, message);
      expect(GatewayMessageSchema.parse(message)).toEqual(message);
    }
    validate("#/definitions/HealthReport", examples.health);
    validate("#/definitions/RecordingFileHeader", examples.recordingHeader);
    validate("#/definitions/RecordingEntry", examples.recordingEntry);
    HealthReportSchema.parse(examples.health);
    RecordingFileHeaderSchema.parse(examples.recordingHeader);
    RecordingEntrySchema.parse(examples.recordingEntry);

    // The examples show every component type, with products on a conveyor.
    expect(new Set(examples.config.components.map((c) => c.type)).size).toBe(8);
    expect(examples.state.components.some((c) => c.type === "conveyor" && c.products.length > 0)).toBe(true);
  }, 30_000);

  it("lets clients ignore fields they do not know: the schema allows extra properties", () => {
    const schema = protocolJsonSchema();
    const ajv = new Ajv();
    const message = { kind: "status", sourceId: "sim", sourceName: "Simulator", status: { plcConnected: true }, extra: 1 };
    expect(ajv.validate(schema, message)).toBe(true);
  });

  it("is served at /docs and /docs/schema.json, without a web app and in front of the web app's fallback", async () => {
    const web = mkdtempSync(join(tmpdir(), "rpp-web-"));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>web app</title>");
    for (const staticDir of [undefined, web]) {
      const sim = createSimulator({ seed: 1 });
      const gateway = createGateway({ plc: sim.plc, sourceId: "sim", sourceName: "Simulator" });
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
          expect(html).toContain("<title>RPP visualisation API</title>");
          for (const id of ["api", "reference", "ref-config", "ref-state", "ref-status", "ref-health", "server-options", "plc-contract", "plc-guide"]) {
            expect(html).toContain(`id="${id}"`);
          }
          expect(html).toContain("1.2.3");
          expect(html).toContain(`<dd>${PROTOCOL_VERSION}</dd>`);
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
