import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AdsBridgeSymbolAccess } from "./ads-bridge-symbol-access";
import { AdsSymbolAccess } from "./ads-symbol-access";
import { combineGateways, createGateway, type Gateway } from "./gateway";
import { OptionsError, resolveGatewayOptions, type GatewayOptions } from "./options";
import { startServer, WS_PATH } from "./server";
import { createSimulator } from "./simulator";
import type { SymbolAccess } from "./symbol-access";

let options: GatewayOptions;
try {
  options = resolveGatewayOptions(process.argv.slice(2), {
    here: dirname(fileURLToPath(import.meta.url)),
    exists: existsSync,
    readFile: (path) => readFileSync(path, "utf8"),
  });
} catch (error) {
  if (!(error instanceof OptionsError)) throw error;
  console.error(`${(error as Error).message}\nRun with --help for the options.`);
  process.exit(1);
}

if (options.help) {
  console.log(`Usage: gateway [options]
  --config <file>            JSON file with any of the options below in camelCase (e.g. "adsPort": 851);
                             relative paths in it resolve against its folder; command-line flags win
  --driver sim|ads|ads-tcp   PLC driver (default: sim)
                             ads:     official Beckhoff ADS library via the .NET bridge (local AMS router,
                                      no route needed; build it with "pnpm build:bridge")
                             ads-tcp: pure TCP client (ads-client); needs a route or AMS TCP loopback
  --ams-net-id <id>          ADS target AmsNetId (default: 127.0.0.1.1.1); a remote IPC needs an ADS route
  --ads-port <port>          ADS target port (default: 851)
                             Several PLCs: "sources": [{ "name": "...", "amsNetId": "...", "adsPort": 851 }]
                             in the config file instead of these two (ads driver only)
  --ads-bridge <exe|dll>     ADS bridge (default: AdsBridge.exe next to the packaged gateway,
                             else apps/ads-bridge/bin/Release/net9.0/AdsBridge.dll)
  --router-address <host>    ads-tcp only: ADS router host when not using the local router
  --router-port <port>       ads-tcp only: ADS router TCP port (default: 48898)
  --local-ams-net-id <id>    ads-tcp only: local AmsNetId when connecting through a remote router
  --cycle-ms <ms>            Acquisition cycle (default: 20)
  --config-recheck-ms <ms>   Re-read the full config at this interval to catch live changes (default: 1000, 0 = off)
  --manifest-path <symbol>   Symbol path of the application's manifest (default: GVL_Visu.stManifest)
  --port <port>              HTTP + WebSocket port (default: 8080)
  --host <addr>              Bind address (default: all interfaces)
  --static-dir <dir>         Built web app to serve (default: web/ next to the packaged gateway, else apps/web/dist)`);
  process.exit(0);
}

const cycleMs = Math.max(1, options.cycleMs);

if (options.driver === "ads" && !existsSync(options.adsBridge)) {
  console.error(`ADS bridge not found at ${options.adsBridge}. Build it with "pnpm build:bridge".`);
  process.exit(1);
}

/** The gateway of one source with its PLC access; each runs its own acquisition loop below. */
interface SourceRuntime {
  name: string;
  gateway: Gateway;
  close(): Promise<void> | void;
}

const simulator = options.driver === "sim" ? createSimulator() : undefined;
const runtimes: SourceRuntime[] = simulator
  ? [runtime("sim", "Simulator", simulator.plc, () => {})]
  : options.sources.map((source) => {
      if (options.driver === "ads") {
        const plc = new AdsBridgeSymbolAccess({
          bridgePath: options.adsBridge,
          targetAmsNetId: source.amsNetId,
          targetAdsPort: source.adsPort,
        });
        return runtime(source.sourceId, source.name, plc, () => plc.close());
      }
      const plc = new AdsSymbolAccess({
        targetAmsNetId: source.amsNetId,
        targetAdsPort: source.adsPort,
        ...(options.routerAddress ? { routerAddress: options.routerAddress } : {}),
        ...(options.routerPort !== undefined ? { routerTcpPort: options.routerPort } : {}),
        ...(options.localAmsNetId ? { localAmsNetId: options.localAmsNetId } : {}),
      });
      return runtime(source.sourceId, source.name, plc, () => plc.close());
    });

function runtime(sourceId: string, name: string, plc: SymbolAccess, close: () => Promise<void> | void): SourceRuntime {
  const gateway = createGateway({
    plc,
    sourceId,
    sourceName: name,
    configRecheckMs: options.configRecheckMs,
    manifestPath: options.manifestPath,
  });
  return { name, gateway, close };
}

const server = await startServer({
  gateway: combineGateways(runtimes.map((r) => r.gateway)),
  port: options.port,
  ...(options.host ? { host: options.host } : {}),
  ...(options.staticDir ? { staticDir: options.staticDir } : {}),
});
console.log(
  `Gateway (${options.driver}) listening on http://${options.host ?? "localhost"}:${options.port}` +
    ` – WebSocket ${WS_PATH}${options.staticDir ? `, serving ${options.staticDir}` : ", no static web app"}`,
);
console.log(`Sources: ${runtimes.map((r) => `${r.name} (${r.gateway.sourceId})`).join(", ")}`);

let stopped = false;

/** Fixed-rate acquisition loop of one source; a slow cycle delays its next one instead of overlapping it. */
async function loop({ name, gateway }: SourceRuntime): Promise<void> {
  // Undefined until the first attempt, so a source that never connects is logged too.
  let lastConnected: boolean | undefined;
  gateway.subscribe((m) => {
    // The initial status (not connected, no error yet) is not news.
    const attempted = m.kind === "status" && (m.status.plcConnected || m.status.lastError !== undefined);
    if (attempted && m.status.plcConnected !== lastConnected) {
      lastConnected = m.status.plcConnected;
      console.log(m.status.plcConnected ? `${name}: PLC connected` : `${name}: PLC not connected: ${m.status.lastError ?? ""}`);
    }
    if (m.kind === "config" && m.errors.length > 0) {
      for (const e of m.errors) console.warn(`${name}: discovery: ${e.path ?? ""} ${e.message}`);
    }
  });
  let lastStep = performance.now();
  while (!stopped) {
    const started = performance.now();
    simulator?.step(started - lastStep);
    lastStep = started;
    await gateway.cycle();
    const wait = cycleMs - (performance.now() - started);
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
}
for (const r of runtimes) void loop(r);

const shutdown = async () => {
  stopped = true;
  server.close();
  await Promise.all(runtimes.map((r) => r.close()));
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
