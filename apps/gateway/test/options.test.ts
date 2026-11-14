import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { helpText, OptionsError, resolveGatewayOptions, type OptionsEnvironment } from "../src/options";

const here = resolve("/install");

function env(files: Record<string, string> = {}, existing: string[] = []): OptionsEnvironment {
  const all = new Map(Object.entries(files).map(([p, c]) => [resolve(p), c]));
  const present = new Set([...all.keys(), ...existing.map((p) => resolve(p))]);
  return {
    here,
    exists: (p) => present.has(resolve(p)),
    readFile: (p) => {
      const content = all.get(resolve(p));
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
  };
}

describe("resolveGatewayOptions", () => {
  it("takes values from the config file and lets command-line flags override them", () => {
    const options = resolveGatewayOptions(
      ["--config", "/data/config.json", "--port", "9000"],
      env({ "/data/config.json": JSON.stringify({ driver: "ads", adsPort: 852, port: 8081, cycleMs: 50 }) }),
    );

    expect(options).toMatchObject({ driver: "ads", port: 9000, cycleMs: 50 });
    expect(options.sources).toEqual([
      { sourceId: "ads:127.0.0.1.1.1:852", name: "127.0.0.1.1.1:852", amsNetId: "127.0.0.1.1.1", adsPort: 852 },
    ]);
  });

  it("only reads unless writing parameter sets is allowed by --allow-write or \"allowWrite\": true (ADR 0017)", () => {
    expect(resolveGatewayOptions([], env())).toMatchObject({ allowWrite: false, configManifestPath: "GVL_Config.stManifest" });
    expect(resolveGatewayOptions(["--allow-write"], env()).allowWrite).toBe(true);
    const fromFile = resolveGatewayOptions(
      ["--config", "/data/config.json"],
      env({ "/data/config.json": JSON.stringify({ allowWrite: true, configManifestPath: "GVL_Params.stManifest" }) }),
    );
    expect(fromFile).toMatchObject({ allowWrite: true, configManifestPath: "GVL_Params.stManifest" });
    expect(() =>
      resolveGatewayOptions(["--config", "/data/config.json"], env({ "/data/config.json": JSON.stringify({ allowWrite: "yes" }) })),
    ).toThrow(/"allowWrite" must be a boolean/);
  });

  it("reads the manifest symbol path from the config file and defaults to GVL_Visu.stManifest", () => {
    const configured = resolveGatewayOptions(
      ["--config", "/data/config.json"],
      env({ "/data/config.json": JSON.stringify({ manifestPath: "GVL_RppVisu.stManifest" }) }),
    );

    expect(configured.manifestPath).toBe("GVL_RppVisu.stManifest");
    expect(resolveGatewayOptions([], env()).manifestPath).toBe("GVL_Visu.stManifest");
  });

  it("accepts a config file saved with a byte order mark, as Notepad and PowerShell 5.1 write it", () => {
    const options = resolveGatewayOptions(
      ["--config", "/data/config.json"],
      env({ "/data/config.json": `﻿${JSON.stringify({ adsPort: 852 })}` }),
    );

    expect(options.sources[0]!.adsPort).toBe(852);
  });

  it.each([
    ["an unknown key", { adsPrt: 852 }, /unknown key "adsPrt"/],
    ["a value of the wrong type", { adsPort: "852" }, /"adsPort" must be a number/],
    ["an unknown driver", { driver: "opcua" }, /driver must be one of ads, ads-tcp/],
    // The gateway's fake PLC is gone (ADR 0020): the demo application on the user-mode runtime takes its place.
    ["the former simulator driver", { driver: "sim" }, /driver must be one of ads, ads-tcp/],
    ["invalid JSON", "{ port: 8080 ", /not valid JSON/],
  ])("rejects a config file with %s", (_, content, message) => {
    const files = { "/data/config.json": typeof content === "string" ? content : JSON.stringify(content) };

    expect(() => resolveGatewayOptions(["--config", "/data/config.json"], env(files))).toThrow(OptionsError);
    expect(() => resolveGatewayOptions(["--config", "/data/config.json"], env(files))).toThrow(message);
  });

  it("uses the bridge exe and every web app next to the bundled gateway when packaged", () => {
    const options = resolveGatewayOptions(
      [],
      env({}, ["/install/AdsBridge.exe", "/install/web", "/install/web/configurator", "/install/web/simulator"]),
    );

    expect(options.adsBridge).toBe(join(here, "AdsBridge.exe"));
    expect(options.staticDir).toBe(join(here, "web"));
    expect(options.configuratorDir).toBe(join(here, "web", "configurator"));
    expect(options.simulatorDir).toBe(join(here, "web", "simulator"));
  });

  it("uses the repo build output when running from source", () => {
    const src = resolve("/repo/apps/gateway/src");
    const options = resolveGatewayOptions([], {
      ...env({}, ["/repo/apps/visualisation/dist", "/repo/apps/configurator/dist", "/repo/apps/simulator/dist"]),
      here: src,
    });

    expect(options.adsBridge).toBe(resolve("/repo/apps/ads-bridge/bin/Release/net9.0/AdsBridge.dll"));
    expect(options.staticDir).toBe(resolve("/repo/apps/visualisation/dist"));
    expect(options.configuratorDir).toBe(resolve("/repo/apps/configurator/dist"));
    expect(options.simulatorDir).toBe(resolve("/repo/apps/simulator/dist"));
  });

  it("serves no web app when none is built", () => {
    const options = resolveGatewayOptions([], env());
    expect(options.staticDir).toBeUndefined();
    expect(options.configuratorDir).toBeUndefined();
    expect(options.simulatorDir).toBeUndefined();
  });

  it("resolves relative paths in the config file against the file's folder", () => {
    const options = resolveGatewayOptions(
      ["--config", "/data/config.json"],
      env({ "/data/config.json": JSON.stringify({
        staticDir: "custom-web",
        configuratorDir: "custom-configurator",
        simulatorDir: "custom-simulator",
        adsBridge: "bin/AdsBridge.exe",
      }) }),
    );

    expect(options.staticDir).toBe(resolve("/data/custom-web"));
    expect(options.configuratorDir).toBe(resolve("/data/custom-configurator"));
    expect(options.simulatorDir).toBe(resolve("/data/custom-simulator"));
    expect(options.adsBridge).toBe(resolve("/data/bin/AdsBridge.exe"));
  });

  it.each([
    ["an unknown flag", ["--ads-prt", "852"]],
    ["a flag without its value", ["--port"]],
    ["a non-numeric port", ["--port", "http"]],
  ])("rejects %s on the command line", (_, argv) => {
    expect(() => resolveGatewayOptions(argv, env())).toThrow(OptionsError);
  });

  it("reads several PLC sources from the config file, the port defaulting to 851", () => {
    const sources = [
      { name: "Infeed PLC", amsNetId: "5.12.34.56.1.1", adsPort: 851 },
      { amsNetId: "5.12.34.57.1.1" },
      { name: "Second runtime", amsNetId: "5.12.34.57.1.1", adsPort: 852 },
    ];
    const options = resolveGatewayOptions(
      ["--config", "/data/config.json"],
      env({ "/data/config.json": JSON.stringify({ driver: "ads", sources }) }),
    );

    expect(options.sources).toEqual([
      { sourceId: "ads:5.12.34.56.1.1:851", name: "Infeed PLC", amsNetId: "5.12.34.56.1.1", adsPort: 851 },
      { sourceId: "ads:5.12.34.57.1.1:851", name: "5.12.34.57.1.1:851", amsNetId: "5.12.34.57.1.1", adsPort: 851 },
      { sourceId: "ads:5.12.34.57.1.1:852", name: "Second runtime", amsNetId: "5.12.34.57.1.1", adsPort: 852 },
    ]);
  });

  it("reads a PLC through the ADS bridge by default and knows no simulator options any more", () => {
    expect(resolveGatewayOptions([], env()).driver).toBe("ads");
    expect(() => resolveGatewayOptions(["--sim-products", "4000"], env())).toThrow(OptionsError);
    expect(helpText()).not.toMatch(/\bsim\b|sim-products/);
  });

  it("takes the AmsNetId and port flags as the short form for one source, defaulting to the local runtime 851", () => {
    expect(resolveGatewayOptions(["--ams-net-id", "5.12.34.56.1.1", "--ads-port", "852"], env()).sources).toEqual([
      { sourceId: "ads:5.12.34.56.1.1:852", name: "5.12.34.56.1.1:852", amsNetId: "5.12.34.56.1.1", adsPort: 852 },
    ]);
    expect(resolveGatewayOptions([], env()).sources.map((s) => s.sourceId)).toEqual(["ads:127.0.0.1.1.1:851"]);
  });

  it.each([
    ["sources and a flag for one source", { sources: [{ amsNetId: "5.1.2.3.1.1" }] }, ["--ads-port", "852"], /either "sources" or/],
    ["sources and amsNetId in the file", { sources: [{ amsNetId: "5.1.2.3.1.1" }], amsNetId: "5.1.2.4.1.1" }, [], /either "sources" or/],
    ["an empty source list", { sources: [] }, [], /"sources" must be a non-empty list/],
    ["a source without AmsNetId", { sources: [{ name: "Line PLC" }] }, [], /sources\[0\]: "amsNetId" must be a string/],
    ["a source with an unknown key", { sources: [{ amsNetId: "5.1.2.3.1.1", port: 851 }] }, [], /sources\[0\]: unknown key "port"/],
    [
      "the same source twice",
      { driver: "ads", sources: [{ amsNetId: "5.1.2.3.1.1" }, { amsNetId: "5.1.2.3.1.1", adsPort: 851 }] },
      [],
      /5.1.2.3.1.1:851 is listed twice/,
    ],
    [
      "several sources with the ads-tcp driver",
      { driver: "ads-tcp", sources: [{ amsNetId: "5.1.2.3.1.1" }, { amsNetId: "5.1.2.4.1.1" }] },
      [],
      /only the ads driver reads several sources/i,
    ],
  ])("rejects %s", (_, config, argv, message) => {
    const files = { "/data/config.json": JSON.stringify(config) };

    expect(() => resolveGatewayOptions(["--config", "/data/config.json", ...argv], env(files))).toThrow(message);
  });

  it("names the config file when it cannot be read", () => {
    expect(() => resolveGatewayOptions(["--config", "/data/missing.json"], env())).toThrow(
      /config file .*missing\.json/,
    );
  });
});
