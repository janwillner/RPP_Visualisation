import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { combineGateways, createGateway } from "../src/gateway";
import { startServer } from "../src/server";
import { fixtureMachine, FIXTURE_SOURCE } from "./fixture-machine";

/** A built app: its page and one asset. */
function builtApp(title: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rpp-${title}-`));
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>${title}</title>`);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), `// ${title}`);
  return dir;
}

async function serve(dirs: { staticDir?: string; configuratorDir?: string }) {
  const machine = fixtureMachine();
  const gateway = createGateway({ plc: machine.plc, sourceId: FIXTURE_SOURCE, sourceName: "Fixture" });
  const server = await startServer({ gateway: combineGateways([gateway]), port: 0, host: "127.0.0.1", ...dirs });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
  };
  return { get, close: () => server.close() };
}

describe("web apps (ADR 0019)", () => {
  it("serves the visualisation at / and the configurator from its own build at /configurator/", async () => {
    const { get, close } = await serve({ staticDir: builtApp("visualisation"), configuratorDir: builtApp("configurator") });
    try {
      expect((await get("/")).text).toContain("visualisation");
      for (const path of ["/configurator", "/configurator/", "/configurator/somewhere"]) {
        const page = await get(path);
        expect(page.type, path).toContain("text/html");
        expect(page.text, path).toContain("configurator");
      }
      expect((await get("/configurator/assets/app.js")).text).toBe("// configurator");
      expect((await get("/assets/app.js")).text).toBe("// visualisation");
      // Any other unknown path falls back to the visualisation.
      expect((await get("/somewhere")).text).toContain("visualisation");
      // Not a configurator path, only a similar name.
      expect((await get("/configurators")).text).toContain("visualisation");
    } finally {
      close();
    }
  }, 30_000);

  it("answers 404 for the configurator when none is built", async () => {
    const { get, close } = await serve({ staticDir: builtApp("visualisation") });
    try {
      expect((await get("/configurator")).status).toBe(404);
      expect((await get("/")).text).toContain("visualisation");
    } finally {
      close();
    }
  }, 30_000);
});
