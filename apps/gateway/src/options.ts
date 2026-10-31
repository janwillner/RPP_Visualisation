import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MANIFEST_PATH } from "./plc-contract";

const drivers = ["sim", "ads", "ads-tcp"] as const;
export type Driver = (typeof drivers)[number];

/** One PLC runtime the gateway reads: an AmsNetId plus ADS port, reached through the local AMS router. */
export interface PlcSource {
  /** `ads:<AmsNetId>:<port>`; identifies the source in every message. */
  sourceId: string;
  /** Display name; `<AmsNetId>:<port>` when none is configured. */
  name: string;
  amsNetId: string;
  adsPort: number;
}

export interface GatewayOptions {
  driver: Driver;
  /** At least one; several only with the `ads` driver. */
  sources: PlcSource[];
  routerAddress?: string;
  routerPort?: number;
  localAmsNetId?: string;
  cycleMs: number;
  configRecheckMs: number;
  /** Symbol path of the application's manifest. */
  manifestPath: string;
  port: number;
  host?: string;
  /** AdsBridge.exe (packaged) or AdsBridge.dll (run through `dotnet`). */
  adsBridge: string;
  /** Built web app to serve; undefined when none is found. */
  staticDir?: string;
  help: boolean;
}

/** What option resolution needs from the outside world; injected so it can be tested without a disk. */
export interface OptionsEnvironment {
  /** Directory of the running gateway module (`apps/gateway/src` in the repo, the install folder when packaged). */
  here: string;
  exists(path: string): boolean;
  readFile(path: string): string;
}

export class OptionsError extends Error {}

const stringKeys = ["driver", "amsNetId", "routerAddress", "localAmsNetId", "host", "manifestPath"] as const;
/** String settings holding paths; relative ones resolve against the config file's folder or the working directory. */
const pathKeys = ["adsBridge", "staticDir"] as const;
const numberKeys = ["adsPort", "routerPort", "cycleMs", "configRecheckMs", "port"] as const;

type StringKey = (typeof stringKeys)[number] | (typeof pathKeys)[number];
type NumberKey = (typeof numberKeys)[number];
type Settings = Partial<Record<StringKey, string> & Record<NumberKey, number>> & { sources?: PlcSource[] };

const DEFAULT_AMS_NET_ID = "127.0.0.1.1.1";
const DEFAULT_ADS_PORT = 851;
const sourceKeys = ["name", "amsNetId", "adsPort"];

function plcSource(amsNetId: string, adsPort: number, name?: string): PlcSource {
  return { sourceId: `ads:${amsNetId}:${adsPort}`, name: name ?? `${amsNetId}:${adsPort}`, amsNetId, adsPort };
}

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const isOneOf = (list: readonly string[], key: string) => list.includes(key);

/** Merges defaults, the `--config` JSON file and command-line flags (flags win) into the gateway options. */
export function resolveGatewayOptions(argv: readonly string[], env: OptionsEnvironment): GatewayOptions {
  const values = parseFlags(argv);
  const flag = (key: string) => {
    const v = values[kebab(key)];
    return typeof v === "string" ? v : undefined;
  };

  const fromFlags: Settings = {};
  for (const key of stringKeys) {
    const v = flag(key);
    if (v !== undefined) fromFlags[key] = v;
  }
  for (const key of pathKeys) {
    const v = flag(key);
    if (v !== undefined) fromFlags[key] = resolve(v);
  }
  for (const key of numberKeys) {
    const v = flag(key);
    if (v !== undefined) fromFlags[key] = toNumber(v, `--${kebab(key)}`);
  }
  const configPath = typeof values.config === "string" ? values.config : undefined;
  const settings: Settings = { ...(configPath ? readConfigFile(configPath, env) : {}), ...fromFlags };

  const driver = settings.driver ?? "sim";
  if (!isOneOf(drivers, driver)) throw new OptionsError(`driver must be one of ${drivers.join(", ")}, got "${driver}"`);
  const staticDir = settings.staticDir ?? defaultStaticDir(env);
  const sources = resolveSources(settings, driver as Driver);

  return {
    driver: driver as Driver,
    sources,
    ...(settings.routerAddress !== undefined ? { routerAddress: settings.routerAddress } : {}),
    ...(settings.routerPort !== undefined ? { routerPort: settings.routerPort } : {}),
    ...(settings.localAmsNetId !== undefined ? { localAmsNetId: settings.localAmsNetId } : {}),
    cycleMs: settings.cycleMs ?? 20,
    configRecheckMs: settings.configRecheckMs ?? 1000,
    manifestPath: settings.manifestPath ?? MANIFEST_PATH,
    port: settings.port ?? 8080,
    ...(settings.host !== undefined ? { host: settings.host } : {}),
    adsBridge: settings.adsBridge ?? defaultBridge(env),
    ...(staticDir !== undefined ? { staticDir } : {}),
    help: values.help === true,
  };
}

/** The `sources` list, or the one source given by `amsNetId` / `adsPort`. */
function resolveSources(settings: Settings, driver: Driver): PlcSource[] {
  if (!settings.sources) {
    return [plcSource(settings.amsNetId ?? DEFAULT_AMS_NET_ID, settings.adsPort ?? DEFAULT_ADS_PORT)];
  }
  if (settings.amsNetId !== undefined || settings.adsPort !== undefined) {
    throw new OptionsError(`Give either "sources" or amsNetId / adsPort for a single source, not both`);
  }
  if (driver === "sim") throw new OptionsError(`The simulator reads no PLC sources; remove "sources" or choose the ads driver`);
  const seen = new Set<string>();
  for (const source of settings.sources) {
    if (seen.has(source.sourceId)) throw new OptionsError(`Source ${source.amsNetId}:${source.adsPort} is listed twice`);
    seen.add(source.sourceId);
  }
  if (settings.sources.length > 1 && driver !== "ads") {
    throw new OptionsError(`Only the ads driver reads several sources; driver is "${driver}"`);
  }
  return settings.sources;
}

function parseSources(value: unknown, path: string): PlcSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OptionsError(`Config file ${path}: "sources" must be a non-empty list`);
  }
  return value.map((raw: unknown, i) => {
    const where = `Config file ${path}: sources[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new OptionsError(`${where} must be an object`);
    const entry = raw as Record<string, unknown>;
    const unknown = Object.keys(entry).find((k) => !sourceKeys.includes(k));
    if (unknown) throw new OptionsError(`${where}: unknown key "${unknown}"`);
    if (typeof entry.amsNetId !== "string") throw new OptionsError(`${where}: "amsNetId" must be a string`);
    if (entry.adsPort !== undefined && !(typeof entry.adsPort === "number" && Number.isFinite(entry.adsPort))) {
      throw new OptionsError(`${where}: "adsPort" must be a number`);
    }
    if (entry.name !== undefined && typeof entry.name !== "string") throw new OptionsError(`${where}: "name" must be a string`);
    return plcSource(entry.amsNetId, (entry.adsPort as number | undefined) ?? DEFAULT_ADS_PORT, entry.name as string | undefined);
  });
}

function parseFlags(argv: readonly string[]): Record<string, string | boolean | undefined> {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        config: { type: "string" },
        help: { type: "boolean", default: false },
        ...Object.fromEntries(
          [...stringKeys, ...pathKeys, ...numberKeys].map((k) => [kebab(k), { type: "string" as const }]),
        ),
      },
    }).values;
  } catch (error) {
    throw new OptionsError((error as Error).message);
  }
}

/** Packaged: AdsBridge.exe next to the bundle. From source: the Release build of apps/ads-bridge. */
function defaultBridge({ here, exists }: OptionsEnvironment): string {
  const packaged = join(here, "AdsBridge.exe");
  return exists(packaged) ? packaged : resolve(here, "../../ads-bridge/bin/Release/net9.0/AdsBridge.dll");
}

/** Packaged: web/ next to the bundle. From source: apps/web/dist. */
function defaultStaticDir({ here, exists }: OptionsEnvironment): string | undefined {
  return [join(here, "web"), resolve(here, "../../web/dist")].find((dir) => exists(dir));
}

function readConfigFile(path: string, env: OptionsEnvironment): Settings {
  let text: string;
  try {
    text = env.readFile(path);
  } catch (error) {
    throw new OptionsError(`Cannot read config file ${path}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new OptionsError(`Config file ${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OptionsError(`Config file ${path} must contain a JSON object`);
  }

  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "sources") {
      settings.sources = parseSources(value, path);
      continue;
    }
    const isPath = isOneOf(pathKeys, key);
    const expected = isPath || isOneOf(stringKeys, key) ? "string" : isOneOf(numberKeys, key) ? "number" : undefined;
    if (!expected) throw new OptionsError(`Config file ${path}: unknown key "${key}"`);
    if (typeof value !== expected || (expected === "number" && !Number.isFinite(value))) {
      throw new OptionsError(`Config file ${path}: "${key}" must be a ${expected}`);
    }
    settings[key] = isPath ? resolve(dirname(path), value as string) : value;
  }
  return settings as Settings;
}

function toNumber(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new OptionsError(`${name} must be a number, got "${value}"`);
  return n;
}
