import {
  PROTOCOL_VERSION,
  type ComponentConfig,
  type ComponentState,
  type ConfigMessage,
  type DiscoveryError,
  type GatewayMessage,
  type GatewayStatus,
} from "@rpp/protocol";
import { mapConveyorConfig, mapConveyorState, mapDeltaConfig, mapDeltaState } from "./mapping";
import {
  E_VisuComponentType,
  MANIFEST_PATH,
  PLC_TYPES,
  enumValue,
  type ST_VisuConveyorConfig,
  type ST_VisuConveyorState,
  type ST_VisuDeltaConfig,
  type ST_VisuDeltaState,
  type ST_VisuManifest,
} from "./plc-contract";
import { SymbolNotFoundError, type SymbolAccess } from "./symbol-access";

export interface GatewayOptions {
  plc: SymbolAccess;
  /** Identifies the PLC in the neutral model (one PLC per gateway in the MVP). */
  sourceId: string;
}

export type GatewayListener = (message: GatewayMessage) => void;

export interface Gateway {
  /** Receive all messages. A new subscriber immediately gets the current status and config, if any. */
  subscribe(listener: GatewayListener): () => void;
  /** Run one acquisition cycle: (re)discover when needed, then read and publish one state snapshot. */
  cycle(): Promise<void>;
}

const COMPONENT_KINDS: Record<number, "conveyor" | "delta"> = {
  [E_VisuComponentType.CONVEYOR]: "conveyor",
  [E_VisuComponentType.DELTA]: "delta",
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

export function createGateway({ plc, sourceId }: GatewayOptions): Gateway {
  const listeners = new Set<GatewayListener>();
  let discovery: Discovery | undefined;
  let status: GatewayStatus = { plcConnected: false };
  /** PLC timestamp of the first snapshot after discovery; tRel is measured from here. */
  let t0: bigint | undefined;

  const emit = (message: GatewayMessage) => {
    for (const l of listeners) l(message);
  };

  async function discover(): Promise<Discovery> {
    const manifest = (await plc.read(MANIFEST_PATH)) as ST_VisuManifest;
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
        path: MANIFEST_PATH,
        message: `PLC reports protocol version ${manifest.nProtocolVersion}, but this gateway expects ${PROTOCOL_VERSION}. Update the Tc3_Visu library or the gateway.`,
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
      if (actualType !== PLC_TYPES[kind]) {
        errors.push({
          componentId: entry.nId,
          path: entry.sPath,
          message: `Symbol has expected type ${PLC_TYPES[kind]} but is ${actualType ?? "missing"}`,
        });
        continue;
      }
      try {
        const raw = await plc.read(`${entry.sPath}.stConfig`);
        const config =
          kind === "conveyor"
            ? mapConveyorConfig(identity, raw as ST_VisuConveyorConfig)
            : mapDeltaConfig(identity, raw as ST_VisuDeltaConfig);
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
    const c = component.config;
    return c.type === "conveyor"
      ? mapConveyorState(c.id, raw as ST_VisuConveyorState)
      : mapDeltaState(c.id, c.hasRotationAxis, raw as ST_VisuDeltaState);
  }

  /**
   * Reads the manifest's config version together with all states in one sum-read, so a config change is
   * detected in the same snapshot. Returns false (and publishes nothing) when the config version changed.
   */
  async function publishSnapshot(current: Discovery): Promise<boolean> {
    const [configVersion, ...raws] = await plc.sumRead([
      CONFIG_VERSION_PATH,
      ...current.active.map((a) => a.statePath),
    ]);
    if (configVersion !== current.config.configVersion) return false;
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
        const current = discovery ?? (await rediscover());
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

const CONFIG_VERSION_PATH = `${MANIFEST_PATH}.nConfigVersion`;
