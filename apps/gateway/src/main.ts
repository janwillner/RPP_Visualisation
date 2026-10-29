import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AdsBridgeSymbolAccess } from "./ads-bridge-symbol-access";
import { AdsSymbolAccess } from "./ads-symbol-access";
import { createGateway } from "./gateway";
import { startServer, WS_PATH } from "./server";
import { createSimulator } from "./simulator";
import type { SymbolAccess } from "./symbol-access";

const here = dirname(fileURLToPath(import.meta.url));
const defaultBridge = resolve(here, "../../ads-bridge/bin/Release/net9.0/AdsBridge.dll");

const { values } = parseArgs({
  options: {
    driver: { type: "string", default: "sim" },
    "ams-net-id": { type: "string", default: "127.0.0.1.1.1" },
    "ads-port": { type: "string", default: "851" },
    "ads-bridge": { type: "string", default: defaultBridge },
    "router-address": { type: "string" },
    "router-port": { type: "string" },
    "local-ams-net-id": { type: "string" },
    "cycle-ms": { type: "string", default: "20" },
    "config-recheck-ms": { type: "string", default: "1000" },
    port: { type: "string", default: "8080" },
    host: { type: "string" },
    "static-dir": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`Usage: gateway [options]
  --driver sim|ads|ads-tcp   PLC driver (default: sim)
                             ads:     official Beckhoff ADS library via the .NET bridge (local AMS router,
                                      no route needed; build it with "pnpm build:bridge")
                             ads-tcp: pure TCP client (ads-client); needs a route or AMS TCP loopback
  --ams-net-id <id>          ADS target AmsNetId (default: 127.0.0.1.1.1)
  --ads-port <port>          ADS target port (default: 851)
  --ads-bridge <dll>         Path to AdsBridge.dll (default: apps/ads-bridge/bin/Release/net9.0)
  --router-address <host>    ads-tcp only: ADS router host when not using the local router
  --router-port <port>       ads-tcp only: ADS router TCP port (default: 48898)
  --local-ams-net-id <id>    ads-tcp only: local AmsNetId when connecting through a remote router
  --cycle-ms <ms>            Acquisition cycle (default: 20)
  --config-recheck-ms <ms>   Re-read the full config at this interval to catch live changes (default: 1000, 0 = off)
  --port <port>              HTTP + WebSocket port (default: 8080)
  --host <addr>              Bind address (default: all interfaces)
  --static-dir <dir>         Built web app to serve (default: apps/web/dist if present)`);
  process.exit(0);
}

const cycleMs = Math.max(1, Number(values["cycle-ms"]));
let plc: SymbolAccess;
let simulator: ReturnType<typeof createSimulator> | undefined;

if (values.driver === "ads") {
  if (!existsSync(values["ads-bridge"]!)) {
    console.error(`ADS bridge not found at ${values["ads-bridge"]}. Build it with "pnpm build:bridge".`);
    process.exit(1);
  }
  plc = new AdsBridgeSymbolAccess({
    bridgePath: values["ads-bridge"]!,
    targetAmsNetId: values["ams-net-id"]!,
    targetAdsPort: Number(values["ads-port"]),
  });
} else if (values.driver === "ads-tcp") {
  plc = new AdsSymbolAccess({
    targetAmsNetId: values["ams-net-id"]!,
    targetAdsPort: Number(values["ads-port"]),
    ...(values["router-address"] ? { routerAddress: values["router-address"] } : {}),
    ...(values["router-port"] ? { routerTcpPort: Number(values["router-port"]) } : {}),
    ...(values["local-ams-net-id"] ? { localAmsNetId: values["local-ams-net-id"] } : {}),
  });
} else if (values.driver === "sim") {
  simulator = createSimulator();
  plc = simulator.plc;
} else {
  console.error(`Unknown driver "${values.driver}". Use sim, ads or ads-tcp.`);
  process.exit(1);
}

const sourceId = values.driver === "sim" ? "sim" : `ads:${values["ams-net-id"]}:${values["ads-port"]}`;
const gateway = createGateway({ plc, sourceId, configRecheckMs: Number(values["config-recheck-ms"]) });
const defaultStatic = resolve(here, "../../web/dist");
const staticDir = values["static-dir"] ?? (existsSync(defaultStatic) ? defaultStatic : undefined);

const server = await startServer({
  gateway,
  port: Number(values.port),
  ...(values.host ? { host: values.host } : {}),
  ...(staticDir ? { staticDir } : {}),
});
console.log(
  `Gateway (${values.driver}) listening on http://${values.host ?? "localhost"}:${values.port}` +
    ` – WebSocket ${WS_PATH}${staticDir ? `, serving ${staticDir}` : ", no static web app"}`,
);

// Fixed-rate acquisition loop; a slow cycle delays the next one instead of overlapping it.
let lastStep = performance.now();
let lastConnected = false;
gateway.subscribe((m) => {
  if (m.kind === "status" && m.status.plcConnected !== lastConnected) {
    lastConnected = m.status.plcConnected;
    console.log(m.status.plcConnected ? "PLC connected" : `PLC not connected: ${m.status.lastError ?? ""}`);
  }
  if (m.kind === "config" && m.errors.length > 0) {
    for (const e of m.errors) console.warn(`Discovery: ${e.path ?? ""} ${e.message}`);
  }
});

let stopped = false;
async function loop(): Promise<void> {
  while (!stopped) {
    const started = performance.now();
    simulator?.step(started - lastStep);
    lastStep = started;
    await gateway.cycle();
    const wait = cycleMs - (performance.now() - started);
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
}
void loop();

const shutdown = async () => {
  stopped = true;
  server.close();
  if (plc instanceof AdsSymbolAccess) await plc.close();
  if (plc instanceof AdsBridgeSymbolAccess) plc.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
