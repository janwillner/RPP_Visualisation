import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdsBridgeSymbolAccess } from "../src/ads-bridge-symbol-access";

/**
 * A stand-in for the .NET bridge, run through node. It answers every read with the path. The first start dies right
 * after its first answer, as a crashing bridge does, so the next request goes to a bridge that is gone.
 * `--ams-net-id` carries the marker file that tells the first start from later ones.
 */
const FAKE_BRIDGE = `
const fs = require("node:fs");
const marker = process.argv[process.argv.indexOf("--ams-net-id") + 1];
const first = !fs.existsSync(marker);
fs.writeFileSync(marker, "started");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const answer = JSON.stringify({ id: request.id, ok: true, value: "read " + request.path }) + "\\n";
  process.stdout.write(answer, () => first && process.exit(3));
});
`;

let access: AdsBridgeSymbolAccess | undefined;
afterEach(() => access?.close());

function fakeBridge(): AdsBridgeSymbolAccess {
  const dir = mkdtempSync(join(tmpdir(), "rpp-bridge-"));
  const script = join(dir, "fake-bridge.cjs");
  writeFileSync(script, FAKE_BRIDGE);
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
    access = fakeBridge();
    await expect(access.read("GVL_Visu.stManifest")).resolves.toBe("read GVL_Visu.stManifest");

    // The bridge died: this request fails (it does not hang or end the gateway) and the next one gets a new bridge.
    await expect(access.read("GVL_Visu.stManifest")).rejects.toThrow(/ADS bridge/);
    await expect(access.read("GVL_Visu.stManifest")).resolves.toBe("read GVL_Visu.stManifest");
  });
});
