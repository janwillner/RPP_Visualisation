import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ComponentConfig,
  type ComponentState,
  type ConfigMessage,
  type DiscoveryError,
  type GatewayMessage,
  type GatewayStatus,
  type ParametersMessage,
} from "@rpp/protocol";
import { AcquisitionStatsRecorder } from "./acquisition-stats";
import { COMPONENTS, componentKind, mapConfig, mapState as mapComponentState } from "./components";
import { CONFIG_MANIFEST_PATH } from "./config-contract";
import {
  commandWrites,
  discoverParameters,
  parameterReadPaths,
  parametersMessage,
  type ParameterDiscovery,
} from "./parameter-access";
import { MANIFEST_PATH, enumValue, type ST_VisuManifest } from "./plc-contract";
import { UnknownEntryError, type EntryMemory } from "./plc-mapping";
import { SymbolNotFoundError, type SymbolAccess } from "./symbol-access";

export interface GatewayOptions {
  plc: SymbolAccess;
  /** Identifies the PLC in the neutral model and in every message. */
  sourceId: string;
  /** Display name of the source, sent with every status. Default: the source id. */
  sourceName?: string;
  /**
   * The full discovery is repeated at this interval and a new config is published if anything differs, so
   * configs changed live in the PLC show up even without a config version bump. Default 1000 ms; 0 disables.
   */
  configRecheckMs?: number;
  /** Symbol path of the application's manifest. Default `GVL_Visu.stManifest`. */
  manifestPath?: string;
  /** Symbol path of the application's Syn_Config manifest (ADR 0017). Default `GVL_Config.stManifest`. */
  configManifestPath?: string;
  /** Parameter sets may be written (`--allow-write`); default false: the gateway only reads. */
  allowWrite?: boolean;
  /** Clock in ms (injectable for tests). */
  now?: () => number;
}

/** What a gateway publishes about its source: the visualisation's messages and the parameter sets (ADR 0017). */
export type SourceMessage = GatewayMessage | ParametersMessage;

export type GatewayListener = (message: SourceMessage) => void;

/** The outcome of a client's command: staged under a stage id, or refused. */
export type GatewayCommandResult = { ok: true; stageId: number } | { ok: false; error: string };

/** After a failed attempt, the PLC is tried again only after this long, so an unreachable IPC costs little. */
export const RECONNECT_MS = 5000;

/** Anything clients can subscribe to: one gateway or several combined. */
export interface MessageSource {
  /** Receive all messages. A new subscriber immediately gets the current status and config, if any. */
  subscribe(listener: GatewayListener): () => void;
  /** How reading a source performs (`GET /health`); undefined for a source this does not read. */
  acquisition(sourceId: string): AcquisitionStatsRecorder | undefined;
  /** Carries out a client's command on the source it names (ADR 0017). */
  command(command: ClientMessage): Promise<GatewayCommandResult>;
}

/** Reads one PLC (one source). */
export interface Gateway extends MessageSource {
  readonly sourceId: string;
  /**
   * Run one acquisition cycle: (re)discover when needed, then read and publish one state snapshot. Within
   * RECONNECT_MS after a failure it returns without touching the PLC.
   */
  cycle(): Promise<void>;
}

/**
 * The messages of several gateways as one stream; each message names its source. Each gateway keeps cycling on
 * its own, so a slow or unreachable PLC does not hold up the others.
 */
export function combineGateways(gateways: readonly Gateway[]): MessageSource {
  return {
    subscribe(listener) {
      const unsubscribes = gateways.map((g) => g.subscribe(listener));
      return () => {
        for (const u of unsubscribes) u();
      };
    },
    acquisition: (sourceId) => gateways.find((g) => g.sourceId === sourceId)?.acquisition(sourceId),
    async command(command) {
      const gateway = gateways.find((g) => g.sourceId === command.sourceId);
      return gateway ? gateway.command(command) : { ok: false, error: `Unknown source ${command.sourceId}` };
    },
  };
}

/** A discovered component whose state is read every cycle. */
interface ActiveComponent {
  config: ComponentConfig;
  statePath: string;
  /** Its mapped register entries of the previous read, for registers read as changes (ADR 0013). */
  memory: EntryMemory;
}

interface Discovery {
  config: ConfigMessage;
  active: ActiveComponent[];
  parameters: ParameterDiscovery;
}

export function createGateway({
  plc,
  sourceId,
  sourceName = sourceId,
  configRecheckMs = 1000,
  manifestPath = MANIFEST_PATH,
  configManifestPath = CONFIG_MANIFEST_PATH,
  allowWrite = false,
  now = () => performance.now(),
}: GatewayOptions): Gateway {
  const configVersionPath = `${manifestPath}.nConfigVersion`;
  const protocolVersionPath = `${manifestPath}.nProtocolVersion`;
  const listeners = new Set<GatewayListener>();
  let discovery: Discovery | undefined;
  let status: GatewayStatus = { plcConnected: false };
  /** PLC timestamp of the first snapshot after discovery; tRel is measured from here. */
  let t0: bigint | undefined;
  let lastConfigCheck = now();
  /** Time of the last failed attempt; undefined while connected. */
  let failedAt: number | undefined;
  const stats = new AcquisitionStatsRecorder();
  /** The last `parameters` message, sent again only when it changes. */
  let parameters: ParametersMessage | undefined;
  /** Stage ids of this gateway's writes: from its start time, so another run's ids are unlikely to repeat. */
  let stageId = Math.floor(Date.now() / 1000) % 1_000_000_000;

  const emit = (message: SourceMessage) => {
    for (const l of listeners) l(message);
  };

  async function discover(): Promise<Discovery> {
    const manifest = (await plc.read(manifestPath)) as ST_VisuManifest;
    const libraryVersion = manifest.sLibraryVersion?.trim() || undefined;
    const errors: DiscoveryError[] = [];
    const active: ActiveComponent[] = [];
    let params: ParameterDiscovery = { present: false, entries: [], reason: "The PLC's Syn_Visu does not match this gateway.", errors: [] };
    const result = (): Discovery => ({
      config: {
        kind: "config",
        sourceId,
        protocolVersion: manifest.nProtocolVersion,
        ...(libraryVersion ? { libraryVersion } : {}),
        configVersion: manifest.nConfigVersion,
        components: active.map((a) => a.config),
        errors: [...errors, ...params.errors],
      },
      active,
      parameters: params,
    });

    if (manifest.nProtocolVersion !== PROTOCOL_VERSION) {
      errors.push({
        path: manifestPath,
        message: `PLC reports protocol version ${manifest.nProtocolVersion}${libraryVersion ? ` (Syn_Visu ${libraryVersion})` : ""}, but this gateway expects ${PROTOCOL_VERSION}. Update the Syn_Visu library or the gateway.`,
      });
      return result();
    }

    for (const entry of manifest.aEntries.slice(0, manifest.nCount)) {
      const kind = componentKind(enumValue(entry.eType));
      const identity = { id: entry.nId, sourceId, name: entry.sName };
      if (!kind) {
        errors.push({
          componentId: entry.nId,
          path: entry.sPath,
          message: `Unknown component type ${enumValue(entry.eType)}`,
        });
        continue;
      }
      const actualType = await plc.typeOf(entry.sPath);
      if (!isExpectedType(actualType, COMPONENTS[kind].plcType)) {
        errors.push({
          componentId: entry.nId,
          path: entry.sPath,
          message: `Symbol has expected type ${COMPONENTS[kind].plcType} but is ${actualType ?? "missing"}`,
        });
        continue;
      }
      try {
        const raw = await plc.read(`${entry.sPath}.stConfig`);
        const config = mapConfig(kind, identity, raw);
        active.push({ config, statePath: `${entry.sPath}.stState`, memory: new Map() });
      } catch (error) {
        // A missing member or an unexpected shape affects this entry only; connection errors propagate.
        if (!(error instanceof SymbolNotFoundError) && !(error instanceof TypeError)) throw error;
        errors.push({
          componentId: entry.nId,
          path: entry.sPath,
          message: `Cannot read ${entry.sPath}.stConfig: ${error.message}`,
        });
      }
    }
    try {
      params = await discoverParameters(plc, configManifestPath, allowWrite);
    } catch (error) {
      // A layout the gateway does not know leaves the source read-only; connection errors propagate.
      if (!(error instanceof TypeError) && !(error instanceof SymbolNotFoundError)) throw error;
      params = { present: true, entries: [], reason: `Cannot read ${configManifestPath}: ${error.message}`, errors: [] };
    }
    return result();
  }

  function mapState(component: ActiveComponent, raw: unknown): ComponentState {
    return mapComponentState(component.config, raw, component.memory);
  }

  /** Registers are read as changes within a session; a new one starts with every entry (ADR 0013). */
  let session = 0;
  const changesSession = () => `${sourceId}#${session}`;
  /** Starts a new session: the next read gives every entry, mapped afresh. */
  function restartChanges(current: Discovery): void {
    session += 1;
    for (const a of current.active) a.memory.clear();
    for (const e of current.parameters.entries) e.memory.clear();
  }

  /**
   * Reads the manifest's protocol and config version together with all states in one sum-read, so a change
   * is detected in the same snapshot. Returns false (and publishes nothing) when either version changed.
   */
  async function publishSnapshot(current: Discovery, retry = true): Promise<boolean> {
    const readStart = performance.now();
    const paramPaths = parameterReadPaths(current.parameters);
    const [protocolVersion, configVersion, ...rest] = await plc.sumRead(
      [protocolVersionPath, configVersionPath, ...current.active.map((a) => a.statePath), ...paramPaths],
      { changes: changesSession() },
    );
    if (protocolVersion !== current.config.protocolVersion || configVersion !== current.config.configVersion) {
      return false;
    }
    const raws = rest.slice(0, current.active.length);
    const mapStart = performance.now();
    let components: ComponentState[];
    let params: ParametersMessage | undefined;
    try {
      components = current.active.map((a, i) => mapState(a, raws[i]));
      if (current.parameters.present) {
        params = parametersMessage(sourceId, current.parameters, rest.slice(current.active.length));
      }
    } catch (error) {
      // Out of step with the PLC access (e.g. a restarted ADS bridge): read again with every entry.
      if (!(error instanceof UnknownEntryError) || !retry) throw error;
      restartChanges(current);
      return publishSnapshot(current, false);
    }
    if (params) publishParameters(params);
    if (current.active.length === 0) return true;
    stats.recordSnapshot(mapStart - readStart, performance.now() - mapStart, components);
    const newest = components.reduce((max, c) => (BigInt(c.timestamp) > max ? BigInt(c.timestamp) : max), 0n);
    t0 ??= newest;
    emit({
      kind: "state",
      sourceId,
      configVersion: current.config.configVersion,
      timestamp: newest.toString(),
      tRel: Number(newest - t0) / 1e6,
      components,
    });
    return true;
  }

  /** Sends the parameter sets when they differ from the last ones sent. */
  function publishParameters(next: ParametersMessage): void {
    if (parameters && JSON.stringify(parameters) === JSON.stringify(next)) return;
    parameters = next;
    emit(next);
  }

  async function rediscover(): Promise<Discovery> {
    const next = await discover();
    parameters = undefined;
    setStatus({ plcConnected: true });
    discovery = next;
    t0 = undefined;
    stats.restart();
    restartChanges(next);
    lastConfigCheck = now();
    emit(next.config);
    return next;
  }

  /** Repeats the discovery and publishes the result only if it differs; the snapshot timeline continues. */
  async function recheckConfig(current: Discovery): Promise<Discovery> {
    lastConfigCheck = now();
    const next = await discover();
    if (JSON.stringify(next.config) === JSON.stringify(current.config)) return current;
    discovery = next;
    restartChanges(next);
    emit(next.config);
    // A client drops a source's parameter sets with its new config: they are sent again with the next snapshot.
    parameters = undefined;
    return next;
  }

  const statusMessage = (): GatewayMessage => ({ kind: "status", sourceId, sourceName, status });

  return {
    sourceId,
    subscribe(listener) {
      listeners.add(listener);
      listener(statusMessage());
      if (discovery) listener(discovery.config);
      if (discovery && parameters) listener(parameters);
      return () => listeners.delete(listener);
    },
    acquisition: (id) => (id === sourceId ? stats : undefined),
    async command(command) {
      if (command.sourceId !== sourceId) return { ok: false, error: `Unknown source ${command.sourceId}` };
      const current = discovery;
      if (!current || !status.plcConnected) return { ok: false, error: "The PLC is not connected." };
      const id = (stageId += 1);
      const planned = commandWrites(command, current.parameters, parameters, id);
      if ("error" in planned) return { ok: false, error: planned.error };
      try {
        await plc.sumWrite(planned.writes);
      } catch (error) {
        return { ok: false, error: `Writing to the PLC failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { ok: true, stageId: id };
    },
    async cycle() {
      if (failedAt !== undefined && now() - failedAt < RECONNECT_MS) return;
      try {
        let current = discovery ?? (await rediscover());
        if (configRecheckMs > 0 && now() - lastConfigCheck >= configRecheckMs) current = await recheckConfig(current);
        if (!(await publishSnapshot(current))) {
          await publishSnapshot(await rediscover());
        }
        failedAt = undefined;
        setStatus({ plcConnected: true });
      } catch (error) {
        failedAt = now();
        // Any failed read is treated as a lost connection; rediscover once the PLC answers again.
        discovery = undefined;
        setStatus({ plcConnected: false, lastError: error instanceof Error ? error.message : String(error) });
      }
    },
  };

  function setStatus(next: GatewayStatus): void {
    if (next.plcConnected === status.plcConnected && next.lastError === status.lastError) return;
    status = next;
    emit(statusMessage());
  }
}

/** Library types may be reported with their namespace, e.g. `SynVisu.ST_VisuDelta`. */
function isExpectedType(actual: string | undefined, expected: string): boolean {
  return actual === expected || (actual?.endsWith(`.${expected}`) ?? false);
}
