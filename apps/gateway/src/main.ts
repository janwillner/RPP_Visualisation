import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AdsBridgeSymbolAccess } from "./ads-bridge-symbol-access";
import { AdsSymbolAccess } from "./ads-symbol-access";
import { combineGateways, createGateway, type Gateway } from "./gateway";
import { helpText, OptionsError, resolveGatewayOptions, type GatewayOptions } from "./options";
import { DOCS_PATH, HEALTH_PATH, startServer, WS_PATH } from "./server";
import type { SymbolAccess } from "./symbol-access";
import { APP_VERSION } from "./version";

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
  console.log(helpText());
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

const runtimes: SourceRuntime[] = options.sources.map((source) => {
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
    configManifestPath: options.configManifestPath,
    allowWrite: options.allowWrite,
  });
  return { name, gateway, close };
}

const server = await startServer({
  gateway: combineGateways(runtimes.map((r) => r.gateway)),
  port: options.port,
  ...(options.host ? { host: options.host } : {}),
  ...(options.staticDir ? { staticDir: options.staticDir } : {}),
  ...(options.configuratorDir ? { configuratorDir: options.configuratorDir } : {}),
});
// ASCII only: the service log is read in consoles and editors with other code pages.
console.log(
  `RPP visualisation ${APP_VERSION}: gateway (${options.driver}) listening on http://${options.host ?? "localhost"}:${options.port}` +
    ` - WebSocket ${WS_PATH}, health ${HEALTH_PATH}, API docs ${DOCS_PATH}${options.staticDir ? `, serving ${options.staticDir}` : ", no static web app"}` +
    `${options.configuratorDir ? `, configurator ${options.configuratorDir}` : ""}`,
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
  while (!stopped) {
    const started = performance.now();
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
