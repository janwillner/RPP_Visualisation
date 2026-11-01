import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdsBridgeSymbolAccess } from "../src/ads-bridge-symbol-access";

/**
 * Stand-ins for the .NET bridge, run through node. They answer every read with the path; only their first start
 * misbehaves. `--ams-net-id` carries the marker file that tells the first start from later ones.
 */
const FAKE_BRIDGE_HEAD = `
const fs = require("node:fs");
const marker = process.argv[process.argv.indexOf("--ams-net-id") + 1];
const first = !fs.existsSync(marker);
fs.writeFileSync(marker, "started");
const answer = (request) => JSON.stringify({ id: request.id, ok: true, value: "read " + request.path }) + "\\n";
`;

/** Dies right after its first answer, as a crashing bridge does, so the next request goes to a bridge that is gone. */
const DYING_BRIDGE = `${FAKE_BRIDGE_HEAD}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  process.stdout.write(answer(JSON.parse(line)), () => first && process.exit(3));
});
`;

/**
 * Keeps running but fails every request, as TwinCAT.Ads does for good once the bridge started before the AMS router
 * was ready (e.g. the service at boot): a new AdsClient in the same process cannot register its port either.
 */
const STUCK_BRIDGE = `${FAKE_BRIDGE_HEAD}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(
    first
      ? JSON.stringify({ id: request.id, ok: false, error: "Cannot register communication port", notFound: false }) + "\\n"
      : answer(request),
  );
});
`;

let access: AdsBridgeSymbolAccess | undefined;
afterEach(() => access?.close());

function fakeBridge(source: string): AdsBridgeSymbolAccess {
  const dir = mkdtempSync(join(tmpdir(), "rpp-bridge-"));
  const script = join(dir, "fake-bridge.cjs");
  writeFileSync(script, source);
  // A non-exe bridge path runs through the "dotnet" command; here that is node.
  return new AdsBridgeSymbolAccess({
    bridgePath: script,
    dotnet: process.execPath,
    targetAmsNetId: join(dir, "started"),
    targetAdsPort: 851,
  });
}

describe("ADS bridge process", () => {
  it("fails the request a dying bridge cannot answer, and starts a new bridge for the next one", async () => {
    access = fakeBridge(DYING_BRIDGE);
    await expect(access.read("GVL_Visu.stManifest")).resolves.toBe("read GVL_Visu.stManifest");

    // The bridge died: this request fails (it does not hang or end the gateway) and the next one gets a new bridge.
    await expect(access.read("GVL_Visu.stManifest")).rejects.toThrow(/ADS bridge/);
    await expect(access.read("GVL_Visu.stManifest")).resolves.toBe("read GVL_Visu.stManifest");
  });

  it("starts a new bridge after a failed request, so a bridge stuck without the AMS router recovers", async () => {
    access = fakeBridge(STUCK_BRIDGE);
    await expect(access.read("GVL_Visu.stManifest")).rejects.toThrow("Cannot register communication port");
    await expect(access.read("GVL_Visu.stManifest")).resolves.toBe("read GVL_Visu.stManifest");
  });
});
