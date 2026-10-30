import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OptionsError, resolveGatewayOptions, type OptionsEnvironment } from "../src/options";

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

    expect(options).toMatchObject({ driver: "ads", adsPort: 852, port: 9000, cycleMs: 50, amsNetId: "127.0.0.1.1.1" });
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

    expect(options.adsPort).toBe(852);
  });

  it.each([
    ["an unknown key", { adsPrt: 852 }, /unknown key "adsPrt"/],
    ["a value of the wrong type", { adsPort: "852" }, /"adsPort" must be a number/],
    ["an unknown driver", { driver: "opcua" }, /driver must be one of sim, ads, ads-tcp/],
    ["invalid JSON", "{ port: 8080 ", /not valid JSON/],
  ])("rejects a config file with %s", (_, content, message) => {
    const files = { "/data/config.json": typeof content === "string" ? content : JSON.stringify(content) };

    expect(() => resolveGatewayOptions(["--config", "/data/config.json"], env(files))).toThrow(OptionsError);
    expect(() => resolveGatewayOptions(["--config", "/data/config.json"], env(files))).toThrow(message);
  });

  it("uses the bridge exe and web app next to the bundled gateway when packaged", () => {
    const options = resolveGatewayOptions([], env({}, ["/install/AdsBridge.exe", "/install/web"]));

    expect(options.adsBridge).toBe(join(here, "AdsBridge.exe"));
    expect(options.staticDir).toBe(join(here, "web"));
  });

  it("uses the repo build output when running from source", () => {
    const src = resolve("/repo/apps/gateway/src");
    const options = resolveGatewayOptions([], { ...env({}, ["/repo/apps/web/dist"]), here: src });

    expect(options.adsBridge).toBe(resolve("/repo/apps/ads-bridge/bin/Release/net9.0/AdsBridge.dll"));
    expect(options.staticDir).toBe(resolve("/repo/apps/web/dist"));
  });

  it("serves no web app when none is built", () => {
    expect(resolveGatewayOptions([], env()).staticDir).toBeUndefined();
  });

  it("resolves relative paths in the config file against the file's folder", () => {
    const options = resolveGatewayOptions(
      ["--config", "/data/config.json"],
      env({ "/data/config.json": JSON.stringify({ staticDir: "custom-web", adsBridge: "bin/AdsBridge.exe" }) }),
    );

    expect(options.staticDir).toBe(resolve("/data/custom-web"));
    expect(options.adsBridge).toBe(resolve("/data/bin/AdsBridge.exe"));
  });

  it.each([
    ["an unknown flag", ["--ads-prt", "852"]],
    ["a flag without its value", ["--port"]],
    ["a non-numeric port", ["--port", "http"]],
  ])("rejects %s on the command line", (_, argv) => {
    expect(() => resolveGatewayOptions(argv, env())).toThrow(OptionsError);
  });

  it("names the config file when it cannot be read", () => {
    expect(() => resolveGatewayOptions(["--config", "/data/missing.json"], env())).toThrow(
      /config file .*missing\.json/,
    );
  });
});
