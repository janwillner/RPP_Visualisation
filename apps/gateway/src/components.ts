import { COMPONENT_SCHEMAS, type ComponentConfig, type ComponentState, type ComponentType } from "@rpp/protocol";
import { E_VisuComponentType } from "./plc-contract";
import { mapPlc, type EntryMemory } from "./plc-mapping";

/** Where a component type lives in the PLC; everything else follows from its schemas in `@rpp/protocol`. */
interface PlcComponentType {
  /** `E_VisuComponentType` value in the manifest. */
  plcValue: number;
  /** PLC data type of the component's contract structure, checked during discovery. */
  plcType: string;
  /** PLC data type of its Syn_Config parameter FB's `vo_Config` (ADR 0017), checked during discovery. */
  plcConfigType: string;
}

/**
 * Every component type the gateway reads, by its `E_VisuComponentType` value and contract structure. A new component
 * needs its schemas in `COMPONENT_SCHEMAS` (`@rpp/protocol`), its PLC structure following the naming conventions of
 * `plc-mapping.ts`, and one entry here; the compiler asks for it.
 */
export const COMPONENTS: Record<ComponentType, PlcComponentType> = {
  conveyor: { plcValue: E_VisuComponentType.CONVEYOR, plcType: "ST_VisuConveyor", plcConfigType: "ST_ConfigConveyor" },
  delta: { plcValue: E_VisuComponentType.DELTA, plcType: "ST_VisuDelta", plcConfigType: "ST_ConfigDelta" },
  xtsGantry: { plcValue: E_VisuComponentType.XTS_GANTRY, plcType: "ST_VisuXtsGantry", plcConfigType: "ST_ConfigXtsGantry" },
  xtsLoop: { plcValue: E_VisuComponentType.XTS_LOOP, plcType: "ST_VisuXtsLoop", plcConfigType: "ST_ConfigXtsLoop" },
  cartesian: { plcValue: E_VisuComponentType.CARTESIAN, plcType: "ST_VisuCartesian", plcConfigType: "ST_ConfigCartesian" },
  // Vision system, product sensor and station share one parameter structure: their bodies are hardware.
  vision: { plcValue: E_VisuComponentType.VISION, plcType: "ST_VisuDetector", plcConfigType: "ST_ConfigBodyComponent" },
  sensor: { plcValue: E_VisuComponentType.SENSOR, plcType: "ST_VisuDetector", plcConfigType: "ST_ConfigBodyComponent" },
  station: { plcValue: E_VisuComponentType.STATION, plcType: "ST_VisuStation", plcConfigType: "ST_ConfigBodyComponent" },
};

/** The component type of a manifest entry's `eType`, undefined when unknown. */
export function componentKind(plcValue: number): ComponentType | undefined {
  return (Object.keys(COMPONENTS) as ComponentType[]).find((k) => COMPONENTS[k].plcValue === plcValue);
}

export interface ComponentIdentity {
  id: number;
  sourceId: string;
  name: string;
}

export function mapConfig(kind: ComponentType, identity: ComponentIdentity, raw: unknown): ComponentConfig {
  return mapPlc(COMPONENT_SCHEMAS[kind].config, raw, { type: kind, ...identity }) as ComponentConfig;
}

/**
 * The PLC reports a state for every possible finger or body; only as many as the config has are kept, also in the
 * entries of lists such as movers.
 */
export function mapState(config: ComponentConfig, raw: unknown, memory?: EntryMemory): ComponentState {
  const state = mapPlc(COMPONENT_SCHEMAS[config.type].state, raw, { type: config.type, id: config.id }, memory) as ComponentState;
  return withConfiguredCounts(state, config);
}

/** Cuts every list of the state named like a list of the config (fingers, bodies) to the config's length. */
function withConfiguredCounts(state: ComponentState, config: ComponentConfig): ComponentState {
  const lists = Object.entries(config).filter((e): e is [string, unknown[]] => Array.isArray(e[1]));
  const cut = (v: unknown) => {
    if (typeof v !== "object" || v === null) return;
    const entry = v as Record<string, unknown>;
    for (const [key, list] of lists) {
      const values = entry[key];
      if (Array.isArray(values)) entry[key] = values.slice(0, list.length);
    }
  };
  cut(state);
  for (const v of Object.values(state)) if (Array.isArray(v)) v.forEach(cut);
  return state;
}
