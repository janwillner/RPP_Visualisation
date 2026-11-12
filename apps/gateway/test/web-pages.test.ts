import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { combineGateways, createGateway } from "../src/gateway";
import { startServer } from "../src/server";
import { createSimulator } from "../src/simulator";

describe("web app pages", () => {
  it("serves the visualisation at / and the configurator at /configurator (ADR 0016)", async () => {
    const web = mkdtempSync(join(tmpdir(), "rpp-web-"));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>visualisation</title>");
    writeFileSync(join(web, "configurator.html"), "<!doctype html><title>configurator</title>");
    const sim = createSimulator({ seed: 1 });
    const gateway = createGateway({ plc: sim.plc, sourceId: "sim", sourceName: "Simulator" });
    const server = await startServer({ gateway: combineGateways([gateway]), port: 0, host: "127.0.0.1", staticDir: web });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = async (path: string) => {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get("content-type")).toContain("text/html");
      return res.text();
    };
    try {
      expect(await page("/")).toContain("visualisation");
      expect(await page("/configurator")).toContain("configurator");
      expect(await page("/configurator/")).toContain("configurator");
      expect(await page("/configurator.html")).toContain("configurator");
      // Any other unknown path still falls back to the visualisation.
      expect(await page("/somewhere")).toContain("visualisation");
    } finally {
      server.close();
    }
  }, 30_000);
});
