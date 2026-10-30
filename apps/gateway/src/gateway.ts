import {
  PROTOCOL_VERSION,
  type ComponentConfig,
  type ComponentState,
  type ConfigMessage,
  type DiscoveryError,
  type GatewayMessage,
  type GatewayStatus,
} from "@rpp/protocol";
import {
  mapCartesianConfig,
  mapCartesianState,
  mapConveyorConfig,
  mapConveyorState,
  mapDeltaConfig,
  mapDeltaState,
  mapXtsGantryConfig,
  mapXtsGantryState,
  mapXtsLoopConfig,
  mapXtsLoopState,
  type ComponentIdentity,
} from "./mapping";
import {
  E_VisuComponentType,
  MANIFEST_PATH,
  PLC_TYPES,
  enumValue,
  type ST_VisuCartesianConfig,
  type ST_VisuCartesianState,
  type ST_VisuConveyorConfig,
  type ST_VisuConveyorState,
  type ST_VisuDeltaConfig,
  type ST_VisuDeltaState,
  type ST_VisuManifest,
  type ST_VisuXtsGantryConfig,
  type ST_VisuXtsGantryState,
  type ST_VisuXtsLoopConfig,
  type ST_VisuXtsLoopState,
} from "./plc-contract";
import { SymbolNotFoundError, type SymbolAccess } from "./symbol-access";

export interface GatewayOptions {
  plc: SymbolAccess;
  /** Identifies the PLC in the neutral model (one PLC per gateway in the MVP). */
  sourceId: string;
  /**
   * The full discovery is repeated at this interval and a new config is published if anything differs, so
   * configs changed live in the PLC show up even without a config version bump. Default 1000 ms; 0 disables.
   */
  configRecheckMs?: number;
  /** Symbol path of the application's manifest. Default `GVL_Visu.stManifest`. */
  manifestPath?: string;
  /** Clock in ms (injectable for tests). */
  now?: () => number;
}

export type GatewayListener = (message: GatewayMessage) => void;

export interface Gateway {
  /** Receive all messages. A new subscriber immediately gets the current status and config, if any. */
  subscribe(listener: GatewayListener): () => void;
  /** Run one acquisition cycle: (re)discover when needed, then read and publish one state snapshot. */
  cycle(): Promise<void>;
}

type ComponentKind = ComponentConfig["type"];

const COMPONENT_KINDS: Record<number, ComponentKind> = {
  [E_VisuComponentType.CONVEYOR]: "conveyor",
  [E_VisuComponentType.DELTA]: "delta",
  [E_VisuComponentType.XTS_GANTRY]: "xtsGantry",
  [E_VisuComponentType.XTS_LOOP]: "xtsLoop",
  [E_VisuComponentType.CARTESIAN]: "cartesian",
};

/** Mapping of each component type's PLC structures to the neutral model. */
const MAPPERS: {
  [K in ComponentKind]: {
    config: (identity: ComponentIdentity, raw: unknown) => ComponentConfig;
    state: (id: number, raw: unknown) => ComponentState;
  };
} = {
  conveyor: {
    config: (i, raw) => mapConveyorConfig(i, raw as ST_VisuConveyorConfig),
    state: (id, raw) => mapConveyorState(id, raw as ST_VisuConveyorState),
  },
  delta: {
    config: (i, raw) => mapDeltaConfig(i, raw as ST_VisuDeltaConfig),
    state: (id, raw) => mapDeltaState(id, raw as ST_VisuDeltaState),
  },
  xtsGantry: {
    config: (i, raw) => mapXtsGantryConfig(i, raw as ST_VisuXtsGantryConfig),
    state: (id, raw) => mapXtsGantryState(id, raw as ST_VisuXtsGantryState),
  },
  xtsLoop: {
    config: (i, raw) => mapXtsLoopConfig(i, raw as ST_VisuXtsLoopConfig),
    state: (id, raw) => mapXtsLoopState(id, raw as ST_VisuXtsLoopState),
  },
  cartesian: {
    config: (i, raw) => mapCartesianConfig(i, raw as ST_VisuCartesianConfig),
    state: (id, raw) => mapCartesianState(id, raw as ST_VisuCartesianState),
  },
};

/** A discovered component whose state is read every cycle. */
interface ActiveComponent {
  config: ComponentConfig;
  statePath: string;
}

interface Discovery {
  config: ConfigMessage;
  active: ActiveComponent[];
}

export function createGateway({
  plc,
  sourceId,
  configRecheckMs = 1000,
  manifestPath = MANIFEST_PATH,
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

  const emit = (message: GatewayMessage) => {
    for (const l of listeners) l(message);
  };

  async function discover(): Promise<Discovery> {
    const manifest = (await plc.read(manifestPath)) as ST_VisuManifest;
    const errors: DiscoveryError[] = [];
    const active: ActiveComponent[] = [];
    const result = (): Discovery => ({
      config: {
        kind: "config",
        protocolVersion: manifest.nProtocolVersion,
        configVersion: manifest.nConfigVersion,
        components: active.map((a) => a.config),
        errors,
      },
      active,
    });

    if (manifest.nProtocolVersion !== PROTOCOL_VERSION) {
      errors.push({
        path: manifestPath,
        message: `PLC reports protocol version ${manifest.nProtocolVersion}, but this gateway expects ${PROTOCOL_VERSION}. Update the Syn_Visu library or the gateway.`,
      });
      return result();
    }

    for (const entry of manifest.aEntries.slice(0, manifest.nCount)) {
      const kind = COMPONENT_KINDS[enumValue(entry.eType)];
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
      if (!isExpectedType(actualType, PLC_TYPES[kind])) {
        errors.push({
          componentId: entry.nId,
          path: entry.sPath,
          message: `Symbol has expected type ${PLC_TYPES[kind]} but is ${actualType ?? "missing"}`,
        });
        continue;
      }
      try {
        const raw = await plc.read(`${entry.sPath}.stConfig`);
        const config = MAPPERS[kind].config(identity, raw);
        active.push({ config, statePath: `${entry.sPath}.stState` });
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
    return result();
  }

  function mapState(component: ActiveComponent, raw: unknown): ComponentState {
    return MAPPERS[component.config.type].state(component.config.id, raw);
  }

  /**
   * Reads the manifest's protocol and config version together with all states in one sum-read, so a change
   * is detected in the same snapshot. Returns false (and publishes nothing) when either version changed.
   */
  async function publishSnapshot(current: Discovery): Promise<boolean> {
    const [protocolVersion, configVersion, ...raws] = await plc.sumRead([
      protocolVersionPath,
      configVersionPath,
      ...current.active.map((a) => a.statePath),
    ]);
    if (protocolVersion !== current.config.protocolVersion || configVersion !== current.config.configVersion) {
      return false;
    }
    if (current.active.length === 0) return true;
    const components = current.active.map((a, i) => mapState(a, raws[i]));
    const newest = components.reduce((max, c) => (BigInt(c.timestamp) > max ? BigInt(c.timestamp) : max), 0n);
    t0 ??= newest;
    emit({
      kind: "state",
      configVersion: current.config.configVersion,
      timestamp: newest.toString(),
      tRel: Number(newest - t0) / 1e6,
      components,
    });
    return true;
  }

  async function rediscover(): Promise<Discovery> {
    const next = await discover();
    setStatus({ plcConnected: true });
    discovery = next;
    t0 = undefined;
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
    emit(next.config);
    return next;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener({ kind: "status", status });
      if (discovery) listener(discovery.config);
      return () => listeners.delete(listener);
    },
    async cycle() {
      try {
        let current = discovery ?? (await rediscover());
        if (configRecheckMs > 0 && now() - lastConfigCheck >= configRecheckMs) current = await recheckConfig(current);
        if (!(await publishSnapshot(current))) {
          await publishSnapshot(await rediscover());
        }
        setStatus({ plcConnected: true });
      } catch (error) {
        // Any failed read is treated as a lost connection; rediscover once the PLC answers again.
        discovery = undefined;
        setStatus({ plcConnected: false, lastError: error instanceof Error ? error.message : String(error) });
      }
    },
  };

  function setStatus(next: GatewayStatus): void {
    if (next.plcConnected === status.plcConnected && next.lastError === status.lastError) return;
    status = next;
    emit({ kind: "status", status });
  }
}

/** Library types may be reported with their namespace, e.g. `Syn_Visu.ST_VisuDelta`. */
function isExpectedType(actual: string | undefined, expected: string): boolean {
  return actual === expected || (actual?.endsWith(`.${expected}`) ?? false);
}
